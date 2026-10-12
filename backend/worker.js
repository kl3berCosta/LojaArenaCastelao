// Worker desacoplado: consome a fila (SNS -> SQS), redimensiona o banner e atualiza RDS, S3, cache e auditoria.
// Reaproveita as mesmas camadas da API (src/lib e src/modules/*/model).
const sharp = require('sharp');
const Event = require('./src/modules/events/event.model');
const { logCrudAction } = require('./src/modules/audit/audit.model');
const { invalidateCache, closeRedis } = require('./src/lib/cache');
const storage = require('./src/lib/storage');
const queue = require('./src/lib/queue');
const db = require('./src/lib/db');

// Após N tentativas o evento é marcado como "failed" e a mensagem é descartada da fila
// (a DLQ da fila captura mensagens que derrubam o processo antes disso).
const MAX_ATTEMPTS = 3;

// Erro sem chance de sucesso em nova tentativa (ex.: imagem corrompida).
class PermanentError extends Error {}

// Retorna true quando a mensagem pode sair da fila (sucesso ou falha definitiva) e false para tentar de novo.
async function processMessage(task, { receiveCount = 1 } = {}) {
  console.log(`[Worker SQS] Processando tarefa de arquivo: ${task.type || 'RESCALE_BANNER'} para evento ${task.eventId} (tentativa ${receiveCount})`);

  try {
    const imageBuffer = await storage.loadImage(task);
    if (!imageBuffer) {
      throw new PermanentError('Não foi possível obter a imagem do banner.');
    }

    // Processamento desacoplado: redimensionamento e otimização da imagem (rescaling)
    console.log(`[Worker Sharp] Iniciando rescaling e otimização para evento ${task.eventId}...`);
    let resizedBuffer;
    try {
      resizedBuffer = await sharp(imageBuffer)
        .resize({ width: 400, height: 260, fit: 'cover', position: 'center' })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
    } catch (sharpError) {
      throw new PermanentError(`Imagem inválida: ${sharpError.message}`);
    }

    // S3: thumbnail em banners/processed/
    const thumbnailUrl = await storage.saveThumbnail(resizedBuffer);
    console.log(`[Worker S3] Thumbnail gerado e armazenado com sucesso: ${thumbnailUrl}`);

    // RDS: erros PROPAGAM, então a mensagem volta para a fila e é reprocessada
    await Event.update(task.eventId, { thumbnailUrl, processingStatus: 'completed' });

    await invalidateCache(['events:list', `events:${task.eventId}`]); // Redis
    await logCrudAction('RESCALE_BANNER_COMPLETED', 'banner_processing', { // DynamoDB
      eventId: task.eventId,
      originalUrl: task.bannerUrl || null,
      thumbnailUrl
    });

    console.log(`[Worker] Processamento concluído com sucesso para evento ${task.eventId}!`);
    return true;
  } catch (error) {
    console.error(`[Worker] Erro ao processar mensagem do evento ${task.eventId}:`, error.message);

    if (error instanceof PermanentError || receiveCount >= MAX_ATTEMPTS) {
      try {
        await Event.update(task.eventId, { processingStatus: 'failed' });
        await invalidateCache(['events:list', `events:${task.eventId}`]);
        await logCrudAction('RESCALE_BANNER_FAILED', 'banner_processing', {
          eventId: task.eventId,
          reason: error.message,
          attempts: receiveCount
        });
        return true; // falha definitiva registrada: descarta a mensagem em vez de reprocessar por 24h
      } catch (markError) {
        console.error('[Worker] Não foi possível marcar o evento como failed:', markError.message);
      }
    }
    return false;
  }
}

async function runOnce() {
  let processedCount = 0;

  // 1. Fila AWS SQS
  if (queue.hasSqs()) {
    let messages = [];
    try {
      messages = await queue.receiveTasks();
    } catch (error) {
      console.warn('[Worker SQS] Erro ao buscar mensagens:', error.message);
    }
    for (const item of messages) {
      const done = await processMessage(item.data, { receiveCount: item.receiveCount });
      if (done) {
        try {
          await queue.deleteMessage(item.receiptHandle);
          processedCount++;
        } catch (delErr) {
          console.warn('[Worker SQS] Erro ao deletar mensagem da fila:', delErr.message);
        }
      }
    }
  }

  // 2. Fila local (fallback para dev)
  let localTask = queue.pullLocalTask();
  while (localTask) {
    await processMessage(localTask, { receiveCount: MAX_ATTEMPTS });
    processedCount++;
    localTask = queue.pullLocalTask();
  }

  return processedCount;
}

let isRunning = true;

async function startLoop() {
  console.log('========================================================');
  console.log('🚀 Worker desacoplado de processamento de arquivos iniciado');
  console.log(`📡 Modo AWS SQS: ${process.env.SQS_QUEUE_URL ? 'Ativado (' + process.env.SQS_QUEUE_URL + ')' : 'Desativado (usando fila local)'}`);
  console.log(`🗄️ Modo AWS RDS: ${db.isConfigured() ? 'Conectado' : 'Fallback store.json'}`);
  console.log(`⚡ Modo ElastiCache Redis: ${process.env.REDIS_HOST || process.env.REDIS_URL ? 'Conectado' : 'Desativado'}`);
  console.log(`📦 Modo Amazon S3: ${process.env.S3_BUCKET_NAME ? 'Ativado (' + process.env.S3_BUCKET_NAME + ')' : 'Local uploads/'}`);
  console.log(`📝 Modo Amazon DynamoDB: ${process.env.DYNAMODB_TABLE_NAME ? 'Ativado' : 'Desativado'}`);
  console.log('========================================================');

  while (isRunning) {
    try {
      await runOnce();
    } catch (err) {
      console.error('[Worker Loop] Erro na iteração:', err.message);
    }
    // Com SQS o long polling (WaitTimeSeconds) já espaça as chamadas; sem ele esperamos 3s.
    if (!queue.hasSqs()) await new Promise((resolve) => setTimeout(resolve, 3000));
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
  processMessage
};
