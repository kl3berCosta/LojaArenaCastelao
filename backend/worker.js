const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { Pool } = require('pg');
const Redis = require('redis');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Após N tentativas o evento é marcado como "failed" e a mensagem é descartada da fila
// (a DLQ da fila captura mensagens que derrubam o processo antes disso).
const MAX_ATTEMPTS = 3;
const AUDIT_PK = 'AUDIT';

// Credenciais vêm da IAM Role da EC2; o cliente é criado quando o recurso está configurado.
const s3 = process.env.S3_BUCKET_NAME ? new S3Client({ region: awsRegion }) : null;
const sqs = process.env.SQS_QUEUE_URL ? new SQSClient({ region: awsRegion }) : null;
const dynamodb = process.env.DYNAMODB_TABLE_NAME
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion }), { marshallOptions: { removeUndefinedValues: true } })
  : null;

const dbConfigured = () => !!(process.env.DATABASE_URL || process.env.DB_HOST);

// Erro sem chance de sucesso em nova tentativa (ex.: imagem corrompida).
class PermanentError extends Error {}

let redisClient = null;
let redisRetryAfter = 0;

async function getRedis() {
  if (redisClient) return redisClient.isReady ? redisClient : null;
  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);
  if (!redisUrl || Date.now() < redisRetryAfter) return null;

  let everReady = false;
  const client = Redis.createClient({
    url: redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => (!everReady && retries >= 2 ? new Error('Redis indisponível') : Math.min(retries * 200 + 100, 3000))
    }
  });
  client.on('error', (err) => console.warn('[Worker Redis] Aviso:', err.message));
  client.on('ready', () => { everReady = true; });
  try {
    await client.connect();
    redisClient = client;
    return client;
  } catch (error) {
    console.warn('[Worker Redis] Não conectado:', error.message);
    redisRetryAfter = Date.now() + 15000;
    try { client.destroy(); } catch (_) { /* já fechado */ }
    return null;
  }
}

async function invalidateCache(keys = ['events:list']) {
  try {
    const client = await getRedis();
    if (!client) return;
    await client.del(keys);
    console.log(`[Worker Redis] Cache invalidado para: ${keys.join(', ')}`);
  } catch (error) {
    console.warn('[Worker Redis] Erro ao invalidar cache:', error.message);
  }
}

// O RDS PostgreSQL 16 exige SSL por padrão (rds.force_ssl=1).
function getPgSsl() {
  const target = `${process.env.DATABASE_URL || ''} ${process.env.DB_HOST || ''}`;
  if (process.env.PG_SSL === 'true' || /rds\.amazonaws\.com/.test(target)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

let pgPool = null;
function getPool() {
  if (!dbConfigured()) return null;
  if (!pgPool) {
    const base = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'appdb'
      };
    pgPool = new Pool({ ...base, ssl: getPgSsl(), max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    pgPool.on('error', (err) => console.warn('[Worker RDS] Erro em conexão ociosa:', err.message));
  }
  return pgPool;
}

async function logAudit(action, payload) {
  if (!dynamodb) {
    return null;
  }
  try {
    const item = {
      id: crypto.randomUUID(),
      pk: AUDIT_PK,
      action,
      resource: 'banner_processing',
      payload: JSON.stringify(payload),
      timestamp: new Date().toISOString()
    };
    await dynamodb.send(new PutCommand({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: item
    }));
    console.log(`[Worker DynamoDB] Log registrado: ${action}`);
    return item;
  } catch (error) {
    console.warn('[Worker DynamoDB] Erro ao auditar:', error.message);
    return null;
  }
}

// Atualiza o evento no RDS. Erros PROPAGAM: se o banco falhar a mensagem volta para a fila e é reprocessada.
// O store.json só é usado em desenvolvimento, quando não há RDS configurado.
async function updateEventStatus(eventId, { thumbnailUrl, status }) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `UPDATE events
       SET thumbnail_url = COALESCE($1, thumbnail_url), processing_status = $2, updated_at = NOW()
       WHERE id = $3`,
      [thumbnailUrl ?? null, status, eventId]
    );
    console.log(`[Worker RDS] Evento ${eventId} -> ${status} (${result.rowCount} linha(s)).`);
    return;
  }

  if (fs.existsSync(DATA_FILE)) {
    const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const ev = Array.isArray(store.events) ? store.events.find((e) => e.id === eventId) : null;
    if (ev) {
      if (thumbnailUrl) ev.thumbnailUrl = thumbnailUrl;
      ev.processingStatus = status;
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
      console.log(`[Worker Store] Evento ${eventId} -> ${status} no store.json.`);
    }
  }
}

async function uploadThumbnailToS3(buffer) {
  const fileName = `thumb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;

  if (!s3) {
    // Fallback local
    const processedDir = path.join(UPLOADS_DIR, 'banners', 'processed');
    fs.mkdirSync(processedDir, { recursive: true });
    fs.writeFileSync(path.join(processedDir, fileName), buffer);
    return `/uploads/banners/processed/${fileName}`;
  }

  const key = `banners/processed/${fileName}`;
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg'
  }));

  return `https://${process.env.S3_BUCKET_NAME}.s3.${awsRegion}.amazonaws.com/${key}`;
}

async function getImageBuffer(payload) {
  // Se veio buffer base64 na mensagem
  if (payload.imageBase64) {
    return Buffer.from(payload.imageBase64, 'base64');
  }

  // Se veio do S3
  if (s3 && payload.s3Bucket && payload.s3Key) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: payload.s3Bucket, Key: payload.s3Key }));
    return Buffer.from(await obj.Body.transformToByteArray());
  }

  // Se veio caminho de arquivo local
  if (payload.localFilePath && fs.existsSync(payload.localFilePath)) {
    return fs.readFileSync(payload.localFilePath);
  }

  // Se for URL HTTP
  if (payload.bannerUrl && payload.bannerUrl.startsWith('http')) {
    const res = await fetch(payload.bannerUrl);
    if (!res.ok) throw new Error(`Download do banner falhou (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  return null;
}

// Retorna true quando a mensagem pode sair da fila (sucesso ou falha definitiva) e false para tentar de novo.
async function processMessage(task, { receiveCount = 1 } = {}) {
  console.log(`[Worker SQS] Processando tarefa de arquivo: ${task.type || 'RESCALE_BANNER'} para evento ${task.eventId} (tentativa ${receiveCount})`);

  try {
    const imageBuffer = await getImageBuffer(task);
    if (!imageBuffer) {
      throw new PermanentError('Não foi possível obter a imagem do banner.');
    }

    // Processamento desacoplado: Redimensionamento e otimização da imagem (rescaling)
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

    // Armazenamento no S3
    const thumbnailUrl = await uploadThumbnailToS3(resizedBuffer);
    console.log(`[Worker S3] Thumbnail gerado e armazenado com sucesso: ${thumbnailUrl}`);

    // Atualização no RDS (banco relacional)
    await updateEventStatus(task.eventId, { thumbnailUrl, status: 'completed' });

    // Invalidação do cache no Redis
    await invalidateCache(['events:list', `events:${task.eventId}`]);

    // Auditoria no DynamoDB (NoSQL)
    await logAudit('RESCALE_BANNER_COMPLETED', {
      eventId: task.eventId,
      originalUrl: task.bannerUrl || null,
      thumbnailUrl,
      timestamp: new Date().toISOString()
    });

    console.log(`[Worker] Processamento concluído com sucesso para evento ${task.eventId}!`);
    return true;
  } catch (error) {
    console.error(`[Worker] Erro ao processar mensagem do evento ${task.eventId}:`, error.message);

    if (error instanceof PermanentError || receiveCount >= MAX_ATTEMPTS) {
      try {
        await updateEventStatus(task.eventId, { status: 'failed' });
        await invalidateCache(['events:list', `events:${task.eventId}`]);
        await logAudit('RESCALE_BANNER_FAILED', { eventId: task.eventId, reason: error.message, attempts: receiveCount });
        return true; // falha definitiva registrada: descarta a mensagem em vez de reprocessar por 24h
      } catch (markError) {
        console.error('[Worker] Não foi possível marcar o evento como failed:', markError.message);
      }
    }
    return false;
  }
}

// Consumo de mensagens da fila local (fallback para testes locais)
function pullLocalQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return null;
  try {
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queue = JSON.parse(raw);
    if (Array.isArray(queue) && queue.length > 0) {
      const task = queue.shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
      return task;
    }
  } catch (err) {
    console.warn('[Worker Queue] Erro ao ler fila local:', err.message);
  }
  return null;
}

async function pollSQS() {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MaxNumberOfMessages: 5,
    WaitTimeSeconds: 5,
    VisibilityTimeout: 120,
    AttributeNames: ['ApproximateReceiveCount']
  }));

  const tasks = [];
  for (const msg of result.Messages || []) {
    try {
      let body = JSON.parse(msg.Body);
      // Suporte se a mensagem veio encapsulada via SNS (sem raw message delivery)
      if (body.TopicArn && body.Message) {
        body = JSON.parse(body.Message);
      }
      tasks.push({
        receiptHandle: msg.ReceiptHandle,
        receiveCount: Number(msg.Attributes?.ApproximateReceiveCount || 1),
        data: body
      });
    } catch (err) {
      // Mensagem ilegível nunca terá sucesso: não é reprocessada (a DLQ captura se algo mais escapar).
      console.warn('[Worker SQS] Mensagem com formato inválido descartada:', err.message);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.SQS_QUEUE_URL, ReceiptHandle: msg.ReceiptHandle }))
        .catch((e) => console.warn('[Worker SQS] Erro ao descartar mensagem inválida:', e.message));
    }
  }
  return tasks;
}

async function runOnce() {
  let processedCount = 0;

  // 1. Fila AWS SQS
  if (sqs) {
    let sqsMessages = [];
    try {
      sqsMessages = await pollSQS();
    } catch (error) {
      console.warn('[Worker SQS] Erro ao buscar mensagens:', error.message);
    }
    for (const item of sqsMessages) {
      const done = await processMessage(item.data, { receiveCount: item.receiveCount });
      if (done) {
        try {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl: process.env.SQS_QUEUE_URL,
            ReceiptHandle: item.receiptHandle
          }));
          processedCount++;
        } catch (delErr) {
          console.warn('[Worker SQS] Erro ao deletar mensagem da fila:', delErr.message);
        }
      }
    }
  }

  // 2. Fila local (fallback para dev)
  let localTask = pullLocalQueue();
  while (localTask) {
    await processMessage(localTask, { receiveCount: MAX_ATTEMPTS });
    processedCount++;
    localTask = pullLocalQueue();
  }

  return processedCount;
}

let isRunning = true;

async function startLoop() {
  console.log('========================================================');
  console.log('🚀 Worker desacoplado de processamento de arquivos iniciado');
  console.log(`📡 Modo AWS SQS: ${process.env.SQS_QUEUE_URL ? 'Ativado (' + process.env.SQS_QUEUE_URL + ')' : 'Desativado (usando fila local)'}`);
  console.log(`🗄️ Modo AWS RDS: ${dbConfigured() ? 'Conectado' : 'Fallback store.json'}`);
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
    if (!sqs) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function stop() {
  console.log('\n[Worker] Finalizando worker de forma graciosa...');
  isRunning = false;
  if (redisClient && redisClient.isOpen) {
    redisClient.quit().catch(() => {});
  }
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
