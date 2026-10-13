// Worker desacoplado: consome as filas SQS e executa o trabalho pesado fora da API.
//  - fila de banners       -> redimensiona a imagem do jogo (sharp) e grava o thumbnail no S3;
//  - fila de ingressos     -> gera o PDF do ingresso com QR code e grava no S3 (privado);
//  - fila de notificações  -> envia o e-mail de confirmação ao cliente (SNS e-mail).
// As duas últimas recebem o MESMO evento PEDIDO_CONFIRMADO, publicado uma vez no SNS (fan-out).
// Também devolve ao estoque as reservas de checkout vencidas.
// Reaproveita as mesmas camadas da API (src/lib e src/modules/*/model).
const sharp = require('sharp');
const Event = require('./src/modules/events/event.model');
const Order = require('./src/modules/orders/order.model');
const Reservation = require('./src/modules/reservations/reservation.model');
const { logCrudAction } = require('./src/modules/audit/audit.model');
const { generateTicketPdf } = require('./src/modules/tickets/ticket.pdf');
const { signDownloadToken } = require('./src/modules/tickets/ticket.token');
const { invalidateCache, closeRedis } = require('./src/lib/cache');
const storage = require('./src/lib/storage');
const queue = require('./src/lib/queue');
const notifier = require('./src/lib/notifier');
const { putMetric } = require('./src/lib/metrics');
const db = require('./src/lib/db');
const { APP_PUBLIC_URL } = require('./src/config');

// Após N tentativas a tarefa é dada como perdida e a mensagem sai da fila
// (a DLQ de cada fila captura mensagens que derrubam o processo antes disso).
const MAX_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 15000;

// Erro sem chance de sucesso em nova tentativa (ex.: imagem corrompida).
class PermanentError extends Error {}

const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Executa a tarefa. Retorna true quando a mensagem pode sair da fila (sucesso ou falha definitiva)
// e false para tentar de novo. `onGiveUp` registra a falha definitiva.
async function runTask(label, receiveCount, fn, onGiveUp) {
  try {
    await fn();
    return true;
  } catch (error) {
    console.error(`[Worker] ${label} falhou (tentativa ${receiveCount}):`, error.message);
    if (error instanceof PermanentError || receiveCount >= MAX_ATTEMPTS) {
      try {
        await onGiveUp(error);
        return true; // falha definitiva registrada: descarta a mensagem em vez de reprocessar por 24h
      } catch (markError) {
        console.error(`[Worker] Não foi possível registrar a falha de ${label}:`, markError.message);
      }
    }
    return false;
  }
}

// ---------- 1. Banner do jogo ----------
async function processMessage(task, { receiveCount = 1 } = {}) {
  console.log(`[Worker] Banner do evento ${task.eventId} (tentativa ${receiveCount})`);
  return runTask(`banner ${task.eventId}`, receiveCount, async () => {
    const imageBuffer = await storage.loadImage(task);
    if (!imageBuffer) throw new PermanentError('Não foi possível obter a imagem do banner.');

    let resizedBuffer;
    try {
      resizedBuffer = await sharp(imageBuffer)
        .resize({ width: 400, height: 260, fit: 'cover', position: 'center' })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
    } catch (sharpError) {
      throw new PermanentError(`Imagem inválida: ${sharpError.message}`);
    }

    const thumbnailUrl = await storage.saveThumbnail(resizedBuffer); // S3
    await Event.update(task.eventId, { thumbnailUrl, processingStatus: 'completed' }); // RDS
    await invalidateCache(['events:list', `events:${task.eventId}`]); // Redis
    await logCrudAction('RESCALE_BANNER_COMPLETED', 'banner_processing', { // DynamoDB
      eventId: task.eventId, originalUrl: task.bannerUrl || null, thumbnailUrl
    });
    console.log(`[Worker] Thumbnail pronto para o evento ${task.eventId}: ${thumbnailUrl}`);
  }, async (error) => {
    await Event.update(task.eventId, { processingStatus: 'failed' });
    await invalidateCache(['events:list', `events:${task.eventId}`]);
    await logCrudAction('RESCALE_BANNER_FAILED', 'banner_processing', {
      eventId: task.eventId, reason: error.message, attempts: receiveCount
    });
  });
}

// ---------- 2. PDF do ingresso (assinante 1 do PEDIDO_CONFIRMADO) ----------
async function processTicket(task, { receiveCount = 1 } = {}) {
  const { order, event } = task;
  console.log(`[Worker] PDF do ingresso ${order?.id} (tentativa ${receiveCount})`);
  return runTask(`PDF ${order?.id}`, receiveCount, async () => {
    if (!order?.id) throw new PermanentError('Mensagem sem pedido.');
    const pdf = await generateTicketPdf(order, event);
    await storage.saveTicket(order.id, pdf); // S3 (prefixo privado tickets/)
    await Order.setTicketStatus(order.id, 'ready'); // RDS
    await logCrudAction('TICKET_PDF_GENERATED', 'ticket', { orderId: order.id, bytes: pdf.length });
    putMetric('TicketPdfsGenerated');
  }, async (error) => {
    await logCrudAction('TICKET_PDF_FAILED', 'ticket', { orderId: order?.id, reason: error.message, attempts: receiveCount });
  });
}

function confirmationEmail(order, event) {
  const teams = event ? `${event.teamHome} x ${event.teamAway}` : order.eventName;
  const date = event ? new Date(event.date).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Fortaleza' }) : '';
  const link = `${APP_PUBLIC_URL}/tickets/${encodeURIComponent(order.id)}/download?token=${signDownloadToken(order.id)}`;
  return {
    subject: `Ingresso confirmado: ${teams}`,
    text: [
      `Olá, ${order.customerName}!`,
      '',
      'Sua compra foi confirmada. Bom jogo!',
      '',
      `Jogo: ${teams}`,
      event ? `Estádio: ${event.stadium}` : null,
      date ? `Data: ${date}` : null,
      `Setor: ${order.sectorName || 'Arquibancada'}`,
      `Quantidade: ${order.quantity}`,
      `Total pago: ${money(order.total)}`,
      `Código localizador: ${order.id}`,
      '',
      'Baixe o seu ingresso (PDF com QR code):',
      link,
      '',
      `Você também encontra seus ingressos em ${APP_PUBLIC_URL}/meus-ingressos.html`
    ].filter((l) => l !== null).join('\n')
  };
}

// ---------- 3. E-mail ao cliente (assinante 2 do PEDIDO_CONFIRMADO) ----------
async function processNotification(task, { receiveCount = 1 } = {}) {
  const { order, event } = task;
  console.log(`[Worker] E-mail do pedido ${order?.id} (tentativa ${receiveCount})`);
  return runTask(`e-mail ${order?.id}`, receiveCount, async () => {
    if (!order?.id || !order.customerEmail) throw new PermanentError('Mensagem sem pedido ou sem e-mail.');
    const { subject, text } = confirmationEmail(order, event);
    const sent = await notifier.sendEmail({ to: order.customerEmail, subject, text });
    await logCrudAction('EMAIL_SENT', 'notification', { orderId: order.id, to: order.customerEmail, provider: sent.provider });
    putMetric('EmailsSent');
  }, async (error) => {
    await logCrudAction('EMAIL_FAILED', 'notification', { orderId: order?.id, reason: error.message, attempts: receiveCount });
  });
}

const HANDLERS = { banner: processMessage, ticket: processTicket, notification: processNotification };

// Tarefas da fila local (desenvolvimento): o tipo vem na própria mensagem
function localHandler(task) {
  if (task.type === 'ORDER_CONFIRMED') return HANDLERS[task.target];
  return processMessage;
}

// Devolve ao estoque as reservas de checkout vencidas
async function sweepReservations() {
  try {
    const eventIds = await Reservation.releaseExpired();
    if (eventIds.length) {
      await invalidateCache(['events:list', ...eventIds.map((id) => `events:${id}`)]);
      console.log(`[Worker] Reservas vencidas devolvidas ao estoque (jogos: ${eventIds.join(', ')})`);
      putMetric('ReservationSweeps');
    }
    return eventIds;
  } catch (error) {
    console.warn('[Worker] Falha ao liberar reservas vencidas:', error.message);
    return [];
  }
}

async function pollQueue({ kind, url }) {
  let processed = 0;
  let messages = [];
  try {
    messages = await queue.receiveTasks(url);
  } catch (error) {
    console.warn(`[Worker SQS] Erro ao buscar mensagens (${kind}):`, error.message);
    return 0;
  }
  for (const item of messages) {
    const done = await HANDLERS[kind](item.data, { receiveCount: item.receiveCount });
    if (!done) continue;
    try {
      await queue.deleteMessage(url, item.receiptHandle);
      processed++;
    } catch (delErr) {
      console.warn(`[Worker SQS] Erro ao deletar mensagem (${kind}):`, delErr.message);
    }
  }
  return processed;
}

async function runOnce() {
  let processedCount = 0;

  // 1. Filas AWS SQS, em paralelo (long polling em cada uma)
  if (queue.hasSqs()) {
    const counts = await Promise.all(queue.configuredQueues().map(pollQueue));
    processedCount += counts.reduce((a, b) => a + b, 0);
  }

  // 2. Fila local (fallback para dev)
  let localTask = queue.pullLocalTask();
  while (localTask) {
    await localHandler(localTask)(localTask, { receiveCount: MAX_ATTEMPTS });
    processedCount++;
    localTask = queue.pullLocalTask();
  }

  // 3. Reservas vencidas
  await sweepReservations();

  return processedCount;
}

let isRunning = true;

async function startLoop() {
  console.log('========================================================');
  console.log('🚀 Worker desacoplado iniciado');
  console.log(`📡 Filas SQS: ${queue.configuredQueues().map((q) => q.kind).join(', ') || 'nenhuma (fila local)'}`);
  console.log(`🗄️ RDS: ${db.isConfigured() ? 'Conectado' : 'Fallback store.json'}`);
  console.log(`📦 S3: ${process.env.S3_BUCKET_NAME || 'Local uploads/'}`);
  console.log(`✉️ E-mail: ${notifier.isEnabled() ? 'Amazon SNS (e-mail)' : 'local (data/outbox)'}`);
  console.log('========================================================');

  let lastSweep = 0;
  while (isRunning) {
    try {
      if (queue.hasSqs()) {
        await Promise.all(queue.configuredQueues().map(pollQueue));
        if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
          lastSweep = Date.now();
          await sweepReservations();
        }
      } else {
        await runOnce();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (err) {
      console.error('[Worker Loop] Erro na iteração:', err.message);
    }
  }
}

function stop() {
  console.log('\n[Worker] Finalizando worker de forma graciosa...');
  isRunning = false;
  closeRedis();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (require.main === module) {
  const isOnce = process.argv.includes('--once');
  if (isOnce) {
    runOnce().then((count) => {
      console.log(`[Worker] Execução única finalizada. ${count} tarefas processadas.`);
      process.exit(0);
    });
  } else {
    startLoop().catch((err) => {
      console.error('[Worker] Falha fatal no loop do worker:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  runOnce,
  processMessage,
  processTicket,
  processNotification,
  sweepReservations
};
