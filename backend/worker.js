const AWS = require('aws-sdk');
const { Client } = require('pg');
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

// Credenciais vêm da IAM Role da EC2; o cliente é criado quando o recurso está configurado.
const s3 = process.env.S3_BUCKET_NAME ? new AWS.S3({ region: awsRegion }) : null;
const sqs = process.env.SQS_QUEUE_URL ? new AWS.SQS({ region: awsRegion }) : null;
const dynamodb = process.env.DYNAMODB_TABLE_NAME ? new AWS.DynamoDB.DocumentClient({ region: awsRegion }) : null;

let redisClient = null;

async function getRedis() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }
  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);
  if (!redisUrl) return null;

  try {
    redisClient = Redis.createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.warn('[Worker Redis] Aviso:', err.message));
    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.warn('[Worker Redis] Não conectado:', error.message);
    return null;
  }
}

async function invalidateCache(keys = ['events:list']) {
  try {
    const client = await getRedis();
    if (!client) return;
    for (const key of keys) {
      await client.del(key);
    }
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

async function getPgClient() {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    return null;
  }
  try {
    const client = new Client({
      ssl: getPgSsl(),
      connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'appdb'}`
    });
    await client.connect();
    return client;
  } catch (error) {
    console.warn('[Worker RDS] Conexão falhou:', error.message);
    return null;
  }
}

async function logAudit(action, payload) {
  if (!dynamodb || !process.env.DYNAMODB_TABLE_NAME) {
    return null;
  }
  try {
    const item = {
      id: crypto.randomUUID(),
      action,
      resource: 'banner_processing',
      payload: JSON.stringify(payload),
      timestamp: new Date().toISOString()
    };
    await dynamodb.put({
      TableName: process.env.DYNAMODB_TABLE_NAME,
      Item: item
    }).promise();
    console.log(`[Worker DynamoDB] Log registrado: ${action}`);
    return item;
  } catch (error) {
    console.warn('[Worker DynamoDB] Erro ao auditar:', error.message);
    return null;
  }
}

async function updateEventThumbnail(eventId, thumbnailUrl) {
  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(
        `UPDATE events 
         SET thumbnail_url = $1, processing_status = 'completed', updated_at = NOW() 
         WHERE id = $2`,
        [thumbnailUrl, eventId]
      );
      await pg.end();
      console.log(`[Worker RDS] Evento ${eventId} atualizado com thumbnail no banco relacional.`);
    } catch (err) {
      console.warn(`[Worker RDS] Erro ao atualizar evento ${eventId}:`, err.message);
      if (pg) await pg.end();
    }
  }

  // Atualiza fallback local store.json
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const store = JSON.parse(raw);
      if (Array.isArray(store.events)) {
        const ev = store.events.find((e) => e.id === eventId);
        if (ev) {
          ev.thumbnailUrl = thumbnailUrl;
          ev.processingStatus = 'completed';
          fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
          console.log(`[Worker Store] Evento ${eventId} atualizado no store.json.`);
        }
      }
    } catch (err) {
      console.warn('[Worker Store] Erro ao atualizar store local:', err.message);
    }
  }
}

async function uploadThumbnailToS3(buffer, originalFileName) {
  if (!s3 || !process.env.S3_BUCKET_NAME) {
    // Fallback local
    const processedDir = path.join(UPLOADS_DIR, 'banners', 'processed');
    fs.mkdirSync(processedDir, { recursive: true });
    const localFileName = `thumb-${Date.now()}-${path.basename(originalFileName || 'image.jpg')}`;
    const targetPath = path.join(processedDir, localFileName);
    fs.writeFileSync(targetPath, buffer);
    return `/uploads/banners/processed/${localFileName}`;
  }

  const key = `banners/processed/thumb-${Date.now()}-${path.basename(originalFileName || 'banner.jpg')}`;
  await s3.putObject({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
    ACL: 'public-read'
  }).promise();

  return `https://${process.env.S3_BUCKET_NAME}.s3.${awsRegion}.amazonaws.com/${key}`;
}

async function getImageBuffer(payload) {
  // Se veio buffer base64 na mensagem
  if (payload.imageBase64) {
    return Buffer.from(payload.imageBase64, 'base64');
  }

  // Se veio do S3
  if (s3 && payload.s3Bucket && payload.s3Key) {
    const s3Obj = await s3.getObject({
      Bucket: payload.s3Bucket,
      Key: payload.s3Key
    }).promise();
    return s3Obj.Body;
  }

  // Se veio caminho de arquivo local
  if (payload.localFilePath && fs.existsSync(payload.localFilePath)) {
    return fs.readFileSync(payload.localFilePath);
  }

  // Se for URL HTTP
  if (payload.bannerUrl && payload.bannerUrl.startsWith('http')) {
    const res = await fetch(payload.bannerUrl);
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  return null;
}

async function processMessage(task) {
  console.log(`[Worker SQS] Processando tarefa de arquivo: ${task.type || 'RESCALE_BANNER'} para evento ${task.eventId}`);

  try {
    const imageBuffer = await getImageBuffer(task);
    if (!imageBuffer) {
      console.warn(`[Worker] Não foi possível obter o buffer de imagem para evento ${task.eventId}`);
      return false;
    }

    // Processamento desacoplado: Redimensionamento e otimização da imagem (rescaling)
    console.log(`[Worker Sharp] Iniciando rescaling e otimização para evento ${task.eventId}...`);
    const resizedBuffer = await sharp(imageBuffer)
      .resize({ width: 400, height: 260, fit: 'cover', position: 'center' })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    // Armazenamento no S3
    const thumbnailUrl = await uploadThumbnailToS3(resizedBuffer, task.fileName || 'banner.jpg');
    console.log(`[Worker S3] Thumbnail gerado e armazenado com sucesso: ${thumbnailUrl}`);

    // Atualização no RDS (banco relacional) e store
    await updateEventThumbnail(task.eventId, thumbnailUrl);

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
    console.error(`[Worker] Erro ao processar mensagem do evento ${task.eventId}:`, error);
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
  if (!sqs || !process.env.SQS_QUEUE_URL) {
    return null;
  }

  try {
    const result = await sqs.receiveMessage({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 60
    }).promise();

    if (!result.Messages || result.Messages.length === 0) {
      return [];
    }

    const tasks = [];
    for (const msg of result.Messages) {
      try {
        let body = JSON.parse(msg.Body);
        // Suporte se a mensagem veio encapsulada via SNS
        if (body.TopicArn && body.Message) {
          body = JSON.parse(body.Message);
        }
        tasks.push({
          receiptHandle: msg.ReceiptHandle,
          data: body
        });
      } catch (err) {
        console.warn('[Worker SQS] Mensagem com formato inválido ignorada:', err.message);
      }
    }
    return tasks;
  } catch (error) {
    console.warn('[Worker SQS] Erro ao buscar mensagens:', error.message);
    return null;
  }
}

async function runOnce() {
  let processedCount = 0;

  // 1. Tenta fila AWS SQS
  if (sqs && process.env.SQS_QUEUE_URL) {
    const sqsMessages = await pollSQS();
    if (sqsMessages && sqsMessages.length > 0) {
      for (const item of sqsMessages) {
        const ok = await processMessage(item.data);
        if (ok && item.receiptHandle) {
          try {
            await sqs.deleteMessage({
              QueueUrl: process.env.SQS_QUEUE_URL,
              ReceiptHandle: item.receiptHandle
            }).promise();
            processedCount++;
          } catch (delErr) {
            console.warn('[Worker SQS] Erro ao deletar mensagem da fila:', delErr.message);
          }
        }
      }
    }
  }

  // 2. Fila local (fallback para dev)
  let localTask = pullLocalQueue();
  while (localTask) {
    await processMessage(localTask);
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
  console.log(`🗄️ Modo AWS RDS: ${process.env.DATABASE_URL || process.env.DB_HOST ? 'Conectado' : 'Fallback store.json'}`);
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
    // Aguarda 3 segundos antes do próximo poll
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
