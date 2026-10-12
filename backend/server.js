const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { Pool } = require('pg');
const Redis = require('redis');

const scrypt = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const awsRegion = process.env.AWS_REGION || 'us-east-1';
const MAX_TICKETS_PER_ORDER = 10;

// Em produção os segredos são obrigatórios: nunca subimos com admin aberto ou JWT previsível.
if (IS_PROD && (!ADMIN_PASSWORD || !process.env.JWT_SECRET)) {
  throw new Error('ADMIN_PASSWORD e JWT_SECRET são obrigatórios quando NODE_ENV=production.');
}
// Fora de produção, sem JWT_SECRET usamos um segredo aleatório por processo (tokens não sobrevivem a restart).
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// AWS SDK v3 clients
// Os clientes são criados quando o recurso está configurado (variável do recurso).
// Na EC2 as credenciais vêm da IAM Role (instance profile), então NÃO dependemos de AWS_ACCESS_KEY_ID.
const s3 = process.env.S3_BUCKET_NAME ? new S3Client({ region: awsRegion }) : null;
const sqs = process.env.SQS_QUEUE_URL ? new SQSClient({ region: awsRegion }) : null;
const sns = process.env.SNS_TOPIC_ARN ? new SNSClient({ region: awsRegion }) : null;
const dynamodb = process.env.DYNAMODB_TABLE_NAME
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion }), { marshallOptions: { removeUndefinedValues: true } })
  : null;

// Somente imagens são aceitas como banner; a extensão vem do tipo MIME, nunca do nome enviado.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error('O banner deve ser uma imagem JPEG, PNG, WEBP ou GIF.');
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  }
});

let redisClient = null;
let redisConnecting = null;
let redisRetryAfter = 0;
const localAuditLogs = [];

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOADS_DIR));

function serverError(res, message, error) {
  console.error(`[API] ${message}`, error);
  const body = { message };
  if (!IS_PROD && error) body.error = error.message;
  return res.status(500).json(body);
}

// ----------------------------------------------------
// Store local (APENAS modo desenvolvimento, quando não há RDS configurado)
// ----------------------------------------------------
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const rawDir = path.join(UPLOADS_DIR, 'banners', 'raw');
  const processedDir = path.join(UPLOADS_DIR, 'banners', 'processed');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ users: [], orders: [], events: initialEvents() }, null, 2),
      'utf8'
    );
  }

  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function initialEvents() {
  return [
    {
      id: 'match-1',
      teamHome: 'Fortaleza',
      teamAway: 'Ceará',
      stadium: 'Arena Castelão',
      date: '2026-10-25T16:00:00',
      price: 80.00,
      available: 320,
      category: 'Arquibancada',
      description: 'Clássico-Rei pelo Campeonato Brasileiro',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    },
    {
      id: 'match-2',
      teamHome: 'Ceará',
      teamAway: 'Sport',
      stadium: 'Arena Castelão',
      date: '2026-11-01T18:30:00',
      price: 60.00,
      available: 210,
      category: 'Cadeiras laterais',
      description: 'Rodada do Campeonato Brasileiro no Castelão',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    },
    {
      id: 'match-3',
      teamHome: 'Ferroviário',
      teamAway: 'Fortaleza',
      stadium: 'Estádio Presidente Vargas',
      date: '2026-11-08T19:00:00',
      price: 40.00,
      available: 260,
      category: 'Arquibancada',
      description: 'Jogo no tradicional Presidente Vargas',
      bannerUrl: null,
      thumbnailUrl: null,
      processingStatus: 'completed'
    }
  ];
}

function loadStore() {
  ensureDirectories();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const store = JSON.parse(raw);
    store.users = store.users || [];
    store.orders = store.orders || [];
    store.events = store.events || [];
    return store;
  } catch (error) {
    return { users: [], orders: [], events: [] };
  }
}

function saveStore(store) {
  ensureDirectories();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// ----------------------------------------------------
// 1. AMAZON RDS (PostgreSQL) - Camada Relacional
// ----------------------------------------------------
// Quando o RDS está configurado ele é a ÚNICA fonte de verdade: se o banco falhar a API retorna erro,
// em vez de gravar em arquivos locais (o que geraria estoque divergente entre as instâncias do ASG).
// O RDS PostgreSQL 16 exige SSL por padrão (rds.force_ssl=1).
function getPgSsl() {
  const target = `${process.env.DATABASE_URL || ''} ${process.env.DB_HOST || ''}`;
  if (process.env.PG_SSL === 'true' || /rds\.amazonaws\.com/.test(target)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function getPgConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: getPgSsl() };
  }
  if (process.env.DB_HOST) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'appdb',
      ssl: getPgSsl()
    };
  }
  return null;
}

let pgPool = null;
function getPool() {
  const config = getPgConfig();
  if (!config) return null;
  if (!pgPool) {
    pgPool = new Pool({ ...config, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    pgPool.on('error', (err) => console.warn('[RDS PostgreSQL] Erro em conexão ociosa:', err.message));
  }
  return pgPool;
}

async function ensureRelationalSchema() {
  const pool = getPool();
  if (!pool) return;

  // schema.sql é a fonte única do esquema (tabelas + índices).
  const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // Advisory lock: várias instâncias do ASG sobem juntas e não podem criar/semear o schema ao mesmo tempo.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(ddl);

    // Semeia os jogos iniciais quando o banco está vazio
    const count = await client.query('SELECT COUNT(*)::int AS n FROM events');
    if (count.rows[0].n === 0) {
      for (const ev of initialEvents()) {
        await client.query(
          `INSERT INTO events (id, team_home, team_away, stadium, event_date, category, price, available, description, banner_url, thumbnail_url, processing_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING`,
          [ev.id, ev.teamHome, ev.teamAway, ev.stadium, ev.date, ev.category, ev.price, ev.available,
            ev.description, ev.bannerUrl, ev.thumbnailUrl, ev.processingStatus || 'completed']
        );
      }
    }
    console.log('[RDS PostgreSQL] Schema relacional verificado com sucesso.');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

function rowToEvent(row) {
  return {
    id: row.id,
    teamHome: row.team_home,
    teamAway: row.team_away,
    stadium: row.stadium,
    date: row.event_date,
    category: row.category,
    price: Number(row.price),
    available: Number(row.available),
    description: row.description,
    bannerUrl: row.banner_url,
    thumbnailUrl: row.thumbnail_url,
    processingStatus: row.processing_status,
    createdAt: row.created_at
  };
}

function rowToOrder(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    eventName: row.event_name,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    quantity: row.quantity,
    total: Number(row.total),
    status: row.status,
    createdAt: row.created_at
  };
}

// ----------------------------------------------------
// 2. AMAZON ELASTICACHE (Redis) - Camada de Cache
// ----------------------------------------------------
// O cache é opcional: se o Redis estiver fora do ar, a API segue direto no RDS.
async function connectRedis() {
  if (redisClient) {
    // Cliente já criado: ele mesmo se reconecta; enquanto não estiver pronto, ignoramos o cache.
    return redisClient.isReady ? redisClient : null;
  }

  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);
  if (!redisUrl) return null;
  if (Date.now() < redisRetryAfter) return null;

  if (!redisConnecting) {
    redisConnecting = (async () => {
      let everReady = false;
      const client = Redis.createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 3000,
          // Na conexão inicial desiste rápido; depois de conectado reconecta para sempre.
          reconnectStrategy: (retries) => (!everReady && retries >= 2 ? new Error('Redis indisponível') : Math.min(retries * 200 + 100, 3000))
        }
      });
      client.on('error', (err) => console.warn('[ElastiCache Redis] Aviso:', err.message));
      client.on('ready', () => { everReady = true; });
      try {
        await client.connect();
        redisClient = client;
        console.log('[ElastiCache Redis] Conectado com sucesso.');
        return client;
      } catch (error) {
        console.warn('[ElastiCache Redis] Erro ao conectar:', error.message);
        redisRetryAfter = Date.now() + 15000;
        try { client.destroy(); } catch (_) { /* já fechado */ }
        return null;
      } finally {
        redisConnecting = null;
      }
    })();
  }
  return redisConnecting;
}

async function getCached(key, fetcher, ttlSeconds = 60) {
  const redis = await connectRedis();
  if (!redis) {
    return fetcher();
  }

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn(`[ElastiCache Redis] Erro ao ler cache de ${key}:`, error.message);
    return fetcher();
  }

  const fresh = await fetcher();
  if (fresh !== null && fresh !== undefined) {
    try {
      await redis.set(key, JSON.stringify(fresh), { EX: ttlSeconds });
    } catch (error) {
      console.warn(`[ElastiCache Redis] Erro ao gravar cache de ${key}:`, error.message);
    }
  }
  return fresh;
}

async function invalidateCache(keys = ['events:list']) {
  const redis = await connectRedis();
  if (!redis) return;

  try {
    await redis.del(keys);
  } catch (error) {
    console.warn('[ElastiCache Redis] Erro ao invalidar cache:', error.message);
  }
}

// ----------------------------------------------------
// 3. AMAZON DYNAMODB - Auditoria NoSQL de Ações do CRUD
// ----------------------------------------------------
// Todo item recebe pk='AUDIT' para entrar no índice global "by-time" (pk + timestamp),
// permitindo listar os registros MAIS RECENTES em ordem (Scan não garante ordem).
const AUDIT_PK = 'AUDIT';
const AUDIT_INDEX = 'by-time';

async function logCrudAction(action, resource, payload) {
  const logEntry = {
    id: crypto.randomUUID(),
    pk: AUDIT_PK,
    action,
    resource,
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  };

  localAuditLogs.unshift(logEntry);
  if (localAuditLogs.length > 100) localAuditLogs.pop();

  if (dynamodb) {
    try {
      await dynamodb.send(new PutCommand({
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: logEntry
      }));
    } catch (error) {
      console.warn('[DynamoDB] Erro ao salvar log de auditoria:', error.message);
    }
  }

  return logEntry;
}

async function listAuditLogs(limit = 100) {
  if (!dynamodb) return localAuditLogs;

  const TableName = process.env.DYNAMODB_TABLE_NAME;
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName,
      IndexName: AUDIT_INDEX,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': AUDIT_PK },
      ScanIndexForward: false,
      Limit: limit
    }));
    return result.Items || [];
  } catch (err) {
    console.warn('[DynamoDB] Query no índice falhou, usando Scan ordenado:', err.message);
  }

  const items = [];
  let startKey;
  do {
    const page = await dynamodb.send(new ScanCommand({ TableName, ExclusiveStartKey: startKey }));
    items.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < 1000);
  items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return items.slice(0, limit);
}

// ----------------------------------------------------
// 4. AMAZON S3 - Armazenamento de Arquivos Binários
// ----------------------------------------------------
// A leitura pública dos objetos é concedida por bucket policy (ver infra/main.tf), não por ACL por objeto.
async function uploadToS3(file, subfolder = 'banners/raw') {
  const extension = IMAGE_TYPES[file.mimetype] || '.jpg';
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`;

  if (s3) {
    const key = `${subfolder}/${fileName}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));

    return {
      url: `https://${process.env.S3_BUCKET_NAME}.s3.${awsRegion}.amazonaws.com/${key}`,
      bucket: process.env.S3_BUCKET_NAME,
      key,
      fileName
    };
  }

  // Fallback local caso S3 não esteja configurado
  const localTarget = path.join(UPLOADS_DIR, subfolder, fileName);
  fs.mkdirSync(path.dirname(localTarget), { recursive: true });
  fs.writeFileSync(localTarget, file.buffer);

  return {
    url: `/uploads/${subfolder}/${fileName}`,
    localPath: localTarget,
    fileName
  };
}

// ----------------------------------------------------
// 5. AMAZON SNS / SQS - Desacoplamento Assíncrono (Req. 6)
// ----------------------------------------------------
// Fluxo na AWS: API -> SNS (tópico) -> SQS (assinatura) -> Worker.
// Sem SNS configurado publicamos direto no SQS; sem nenhum dos dois, usa a fila local (dev).
async function enqueueBannerTask(taskPayload) {
  const message = {
    type: 'RESCALE_BANNER',
    ...taskPayload,
    enqueuedAt: new Date().toISOString()
  };

  if (sns) {
    await sns.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: 'Process Banner Task',
      Message: JSON.stringify(message)
    }));
    return { provider: 'Amazon SNS -> SQS', enqueued: true };
  }

  if (sqs) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message)
    }));
    return { provider: 'Amazon SQS', enqueued: true };
  }

  // Fallback fila local (arquivo queue.json lido pelo worker)
  try {
    ensureDirectories();
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queue = JSON.parse(raw);
    queue.push(message);
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
    return { provider: 'Local Queue', enqueued: true };
  } catch (error) {
    console.warn('[Queue] Erro ao enfileirar tarefa local:', error.message);
    return { provider: 'Local Queue (erro)', enqueued: false };
  }
}

async function enqueueBannerSafely(eventId, s3Info, file, bannerUrl) {
  try {
    return await enqueueBannerTask({
      eventId,
      bannerUrl,
      s3Bucket: s3Info?.bucket,
      s3Key: s3Info?.key,
      localFilePath: s3Info?.localPath,
      imageBase64: !s3Info?.bucket ? file.buffer.toString('base64') : null,
      fileName: file.originalname
    });
  } catch (error) {
    // O evento já foi salvo: marcamos o processamento como falho em vez de perder a requisição.
    console.error('[Queue] Falha ao enfileirar processamento do banner:', error);
    await dbUpdateEvent(eventId, { processingStatus: 'failed' }).catch(() => {});
    await invalidateCache(['events:list', `events:${eventId}`]);
    return null;
  }
}

// ----------------------------------------------------
// OPERAÇÕES DE DADOS (RDS; store local só em dev sem banco)
// ----------------------------------------------------
async function dbListEvents() {
  const pool = getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM events ORDER BY event_date ASC');
    return result.rows.map(rowToEvent);
  }
  return loadStore().events;
}

async function dbGetEventById(id) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    return result.rows.length ? rowToEvent(result.rows[0]) : null;
  }
  return loadStore().events.find((e) => e.id === id) || null;
}

async function dbCreateEvent(eventData) {
  const pool = getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO events
       (id, team_home, team_away, stadium, event_date, category, price, available, description, banner_url, thumbnail_url, processing_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
      [
        eventData.id,
        eventData.teamHome,
        eventData.teamAway,
        eventData.stadium,
        eventData.date,
        eventData.category || 'Arquibancada',
        eventData.price,
        eventData.available,
        eventData.description || '',
        eventData.bannerUrl || null,
        eventData.thumbnailUrl || null,
        eventData.processingStatus || 'completed'
      ]
    );
    return eventData;
  }

  const store = loadStore();
  store.events.unshift(eventData);
  saveStore(store);
  return eventData;
}

const EVENT_COLUMNS = {
  teamHome: 'team_home',
  teamAway: 'team_away',
  stadium: 'stadium',
  date: 'event_date',
  category: 'category',
  price: 'price',
  available: 'available',
  description: 'description',
  bannerUrl: 'banner_url',
  thumbnailUrl: 'thumbnail_url',
  processingStatus: 'processing_status'
};

// Atualiza SOMENTE os campos informados (um UPDATE com todas as colunas sobrescreveria,
// por exemplo, o estoque decrementado por uma compra concorrente ou o thumbnail gravado pelo worker).
async function dbUpdateEvent(id, updates) {
  const fields = Object.keys(updates).filter((k) => EVENT_COLUMNS[k]);

  const pool = getPool();
  if (pool) {
    if (fields.length === 0) return dbGetEventById(id);
    const sets = fields.map((k, i) => `${EVENT_COLUMNS[k]} = $${i + 1}`);
    const values = fields.map((k) => updates[k]);
    const result = await pool.query(
      `UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${fields.length + 1} RETURNING *`,
      [...values, id]
    );
    return result.rows.length ? rowToEvent(result.rows[0]) : null;
  }

  const store = loadStore();
  const idx = store.events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const merged = { ...store.events[idx], updatedAt: new Date().toISOString() };
  for (const k of fields) merged[k] = updates[k];
  store.events[idx] = merged;
  saveStore(store);
  return merged;
}

async function dbDeleteEvent(id) {
  const existing = await dbGetEventById(id);
  if (!existing) return null;

  const pool = getPool();
  if (pool) {
    await pool.query('DELETE FROM events WHERE id = $1', [id]);
    return existing;
  }

  const store = loadStore();
  store.events = store.events.filter((e) => e.id !== id);
  saveStore(store);
  return existing;
}

// Compra com controle de concorrência no RDS: o UPDATE condicional é atômico e a trava de linha
// serializa compradores simultâneos do mesmo jogo, então nunca vende mais do que o estoque.
async function dbPurchaseTickets(eventId, quantity, customerName, customerEmail) {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updateResult = await client.query(
        `UPDATE events
         SET available = available - $1, updated_at = NOW()
         WHERE id = $2 AND available >= $1
         RETURNING *`,
        [quantity, eventId]
      );

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        const exists = await client.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
        if (exists.rows.length === 0) {
          return { success: false, notFound: true, reason: 'Evento não encontrado.' };
        }
        return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente.' };
      }

      const eventRow = updateResult.rows[0];
      const total = Number(eventRow.price) * quantity;
      const orderId = `order-${crypto.randomUUID()}`;
      const eventName = `${eventRow.team_home} x ${eventRow.team_away}`;

      await client.query(
        `INSERT INTO orders (id, event_id, event_name, customer_name, customer_email, quantity, total, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', NOW())`,
        [orderId, eventId, eventName, customerName, customerEmail, quantity, total]
      );

      await client.query('COMMIT');

      return {
        success: true,
        event: rowToEvent(eventRow),
        order: {
          id: orderId,
          eventId,
          eventName,
          customerName,
          customerEmail,
          quantity,
          total,
          status: 'confirmed',
          createdAt: new Date().toISOString()
        }
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Modo desenvolvimento (sem RDS): store.json
  const store = loadStore();
  const event = store.events.find((e) => e.id === eventId);
  if (!event) return { success: false, notFound: true, reason: 'Evento não encontrado.' };
  if (event.available < quantity) return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente.' };

  const total = Number(event.price) * quantity;
  const order = {
    id: `order-${crypto.randomUUID()}`,
    eventId,
    eventName: `${event.teamHome} x ${event.teamAway}`,
    customerName,
    customerEmail,
    quantity,
    total,
    status: 'confirmed',
    createdAt: new Date().toISOString()
  };

  event.available -= quantity;
  store.orders.unshift(order);
  saveStore(store);

  return { success: true, order, event };
}

async function dbListOrders() {
  const pool = getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    return result.rows.map(rowToOrder);
  }
  return loadStore().orders;
}

// ----------------------------------------------------
// USUÁRIOS (RDS; store local só em dev sem banco)
// ----------------------------------------------------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

async function dbFindUserByEmail(email) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return { id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash };
  }
  return loadStore().users.find((u) => u.email === email) || null;
}

// Retorna false se o e-mail já existe.
async function dbCreateUser(user) {
  const pool = getPool();
  if (pool) {
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [user.id, user.name, user.email, user.passwordHash]
    );
    return result.rowCount === 1;
  }
  const store = loadStore();
  if (store.users.some((u) => u.email === user.email)) return false;
  store.users.push(user);
  saveStore(store);
  return true;
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

// ----------------------------------------------------
// VALIDAÇÃO DE ENTRADA
// ----------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Converte e valida os campos de um evento. Em modo parcial (PUT) só valida o que foi enviado.
function parseEventFields(body, { partial }) {
  const values = {};
  const errors = [];
  const has = (k) => body[k] !== undefined && body[k] !== '';

  for (const [key, label] of [['teamHome', 'time mandante'], ['teamAway', 'time visitante'], ['stadium', 'estádio']]) {
    if (has(key)) values[key] = String(body[key]).trim();
    else if (!partial) errors.push(label);
  }
  if (has('category')) values.category = String(body.category).trim();
  if (body.description !== undefined) values.description = String(body.description);

  if (has('date')) {
    const d = new Date(body.date);
    if (Number.isNaN(d.getTime())) errors.push('data válida');
    else values.date = d.toISOString();
  } else if (!partial) errors.push('data');

  if (has('price')) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) errors.push('preço maior que zero');
    else values.price = price;
  } else if (!partial) errors.push('preço');

  if (has('available')) {
    const available = Number(body.available);
    if (!Number.isInteger(available) || available < 0) errors.push('quantidade disponível (inteiro ≥ 0)');
    else values.available = available;
  }

  if (has('bannerUrl')) {
    if (/^https?:\/\//i.test(String(body.bannerUrl))) values.bannerUrl = String(body.bannerUrl);
    else errors.push('bannerUrl http(s)');
  }

  return { values, errors };
}

// ----------------------------------------------------
// ACESSO ADMINISTRATIVO E AUTENTICAÇÃO DE USUÁRIO
// Se ADMIN_PASSWORD estiver definido, as rotas de CRUD/auditoria exigem token de admin.
// Sem ADMIN_PASSWORD (apenas desenvolvimento local/testes) as rotas ficam abertas;
// em produção o servidor nem sobe sem ADMIN_PASSWORD.
// ----------------------------------------------------
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const payload = readToken(req);
  if (payload && payload.role === 'admin') return next();
  return res.status(401).json({ message: 'Acesso restrito ao administrador.' });
}

function requireUser(req, res, next) {
  const payload = readToken(req);
  if (payload && payload.email && payload.role !== 'admin') {
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    return next();
  }
  return res.status(401).json({ message: 'Faça login para comprar ingressos.' });
}

// ----------------------------------------------------
// ROTAS DA API
// ----------------------------------------------------

// Nenhuma rota de dados atende antes do schema do RDS estar pronto (o /health responde sempre,
// para o ALB não derrubar a instância enquanto ela inicializa).
let bootstrapPromise = Promise.resolve();
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  return bootstrapPromise.then(() => next(), () => res.status(503).json({ message: 'Serviço indisponível: banco de dados não inicializado.' }));
});

// 1. Healthcheck detalhado dos serviços da AWS
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'stadium-tickets-api',
    instance: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: process.uptime()
    },
    awsServices: {
      ec2: process.env.EC2_INSTANCE_ID || 'executando-na-instancia-ec2',
      rds: !!(process.env.DATABASE_URL || process.env.DB_HOST),
      elasticache: !!(process.env.REDIS_HOST || process.env.REDIS_URL),
      s3: !!process.env.S3_BUCKET_NAME,
      dynamodb: !!process.env.DYNAMODB_TABLE_NAME,
      sqsSns: !!(process.env.SQS_QUEUE_URL || process.env.SNS_TOPIC_ARN)
    }
  });
});

// 2. Rota para teste de estresse de CPU (Parte 2 - Demonstração Auto Scaling). Restrita ao admin.
// Limite de 30s por requisição, abaixo do idle timeout de 60s do ALB.
app.get('/stress', requireAdmin, (req, res) => {
  const requested = Number(req.query.duration);
  const durationMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10000, 30000);
  const start = Date.now();
  // Loop intensivo de CPU em fatias de 50ms, cedendo o event loop entre elas:
  // a CPU vai a ~100% (dispara o Auto Scaling) sem travar o /health do ALB.
  const tick = () => {
    const sliceEnd = Date.now() + 50;
    while (Date.now() < sliceEnd) {
      Math.sqrt(Math.random() * 1000000);
    }
    if (Date.now() - start < durationMs) {
      setImmediate(tick);
    } else {
      res.json({
        message: `Carga de CPU executada por ${durationMs}ms`,
        instance: os.hostname()
      });
    }
  };
  tick();
});

// 3. Listagem de Eventos com Cache no ElastiCache (Redis)
app.get('/events', async (req, res) => {
  try {
    const events = await getCached('events:list', () => dbListEvents(), 60);
    logCrudAction('READ', 'event-list', { count: events.length }); // auditoria sem bloquear a resposta
    res.json(events);
  } catch (error) {
    serverError(res, 'Erro ao listar eventos.', error);
  }
});

// 4. Detalhes de um Evento (com log de auditoria no DynamoDB)
app.get('/events/:id', async (req, res) => {
  try {
    const event = await getCached(`events:${req.params.id}`, () => dbGetEventById(req.params.id), 60);
    if (!event) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    await logCrudAction('READ', 'event', { eventId: event.id, eventName: `${event.teamHome} x ${event.teamAway}` });
    res.json(event);
  } catch (error) {
    serverError(res, 'Erro ao buscar evento.', error);
  }
});

// 5. Criação de Evento com Upload de Imagem e Desacoplamento via SNS/SQS
app.post('/events', requireAdmin, upload.single('banner'), async (req, res) => {
  const { values, errors } = parseEventFields(req.body || {}, { partial: false });
  if (errors.length) {
    return res.status(400).json({ message: `Campos inválidos ou ausentes: ${errors.join(', ')}.` });
  }

  try {
    const eventId = `match-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    let bannerUrl = values.bannerUrl || null;
    let s3Info = null;

    // Se houve envio de imagem binária
    if (req.file) {
      s3Info = await uploadToS3(req.file, 'banners/raw');
      bannerUrl = s3Info.url;
    }

    const newEvent = {
      id: eventId,
      teamHome: values.teamHome,
      teamAway: values.teamAway,
      stadium: values.stadium,
      date: values.date,
      category: values.category || 'Arquibancada',
      price: values.price,
      available: values.available ?? 100,
      description: values.description || '',
      bannerUrl,
      thumbnailUrl: null,
      processingStatus: req.file ? 'pending' : 'completed',
      createdAt: new Date().toISOString()
    };

    // 1. Salva no RDS (PostgreSQL)
    await dbCreateEvent(newEvent);

    // 2. Registra auditoria no DynamoDB (NoSQL)
    await logCrudAction('CREATE', 'event', newEvent);

    // 3. Invalida cache no Redis
    await invalidateCache(['events:list']);

    // 4. Se tiver imagem, DESACOPLA o processamento enviando tarefa para o SNS/SQS
    let queueInfo = null;
    if (req.file) {
      queueInfo = await enqueueBannerSafely(eventId, s3Info, req.file, bannerUrl);
      if (!queueInfo) newEvent.processingStatus = 'failed';
    }

    return res.status(201).json({
      message: 'Evento cadastrado com sucesso!',
      event: newEvent,
      decoupledProcessing: queueInfo ? { enqueued: queueInfo.enqueued, provider: queueInfo.provider } : null
    });
  } catch (error) {
    return serverError(res, 'Erro ao criar evento.', error);
  }
});

// 6. Atualização de Evento (CRUD Update)
app.put('/events/:id', requireAdmin, upload.single('banner'), async (req, res) => {
  try {
    const existing = await dbGetEventById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    // Lista branca de campos: ignora id, thumbnailUrl, processingStatus etc. vindos do cliente.
    const { values: updates, errors } = parseEventFields(req.body || {}, { partial: true });
    if (errors.length) {
      return res.status(400).json({ message: `Campos inválidos: ${errors.join(', ')}.` });
    }

    let s3Info = null;
    if (req.file) {
      s3Info = await uploadToS3(req.file, 'banners/raw');
      updates.bannerUrl = s3Info.url;
      updates.thumbnailUrl = null; // o thumbnail antigo não corresponde mais ao novo banner
      updates.processingStatus = 'pending';
    }

    const updated = await dbUpdateEvent(req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    // Auditoria no DynamoDB
    await logCrudAction('UPDATE', 'event', updated);

    // Invalida cache no Redis
    await invalidateCache(['events:list', `events:${req.params.id}`]);

    // Enfileira processamento se imagem foi alterada
    if (req.file) {
      const queueInfo = await enqueueBannerSafely(updated.id, s3Info, req.file, updated.bannerUrl);
      if (!queueInfo) updated.processingStatus = 'failed';
    }

    return res.json({
      message: 'Evento atualizado com sucesso!',
      event: updated
    });
  } catch (error) {
    return serverError(res, 'Erro ao atualizar evento.', error);
  }
});

// 7. Exclusão de Evento (CRUD Delete)
app.delete('/events/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await dbDeleteEvent(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    // Auditoria no DynamoDB
    await logCrudAction('DELETE', 'event', deleted);

    // Invalida cache no Redis
    await invalidateCache(['events:list', `events:${req.params.id}`]);

    return res.json({ message: 'Evento removido com sucesso!', event: deleted });
  } catch (error) {
    return serverError(res, 'Erro ao excluir evento.', error);
  }
});

// 8. Compra de Ingressos (Orders) com controle de estoque concorrente. Exige usuário autenticado.
app.post('/orders', requireUser, async (req, res) => {
  const { eventId } = req.body || {};
  const quantity = Number(req.body?.quantity);

  if (!eventId || typeof eventId !== 'string') {
    return res.status(400).json({ message: 'ID do evento é obrigatório.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
    return res.status(400).json({ message: `Quantidade deve ser um inteiro entre 1 e ${MAX_TICKETS_PER_ORDER}.` });
  }

  try {
    const result = await dbPurchaseTickets(eventId, quantity, req.user.name, req.user.email);

    if (!result.success) {
      return res.status(result.notFound ? 404 : 409).json({ message: result.reason });
    }

    // Auditoria da compra no DynamoDB
    await logCrudAction('ORDER', 'order', result.order);

    // Invalida cache do evento no Redis para refletir estoque restante
    await invalidateCache(['events:list', `events:${eventId}`]);

    return res.status(201).json({
      message: 'Compra realizada com sucesso!',
      order: result.order
    });
  } catch (error) {
    return serverError(res, 'Erro ao processar compra.', error);
  }
});

// 9. Listagem de Pedidos
app.get('/orders', requireAdmin, async (req, res) => {
  try {
    return res.json(await dbListOrders());
  } catch (error) {
    return serverError(res, 'Erro ao listar pedidos.', error);
  }
});

// 10. Listagem de Logs de Auditoria do DynamoDB (mais recentes primeiro)
app.get('/audit-logs', requireAdmin, async (req, res) => {
  try {
    return res.json(await listAuditLogs(100));
  } catch (error) {
    console.warn('[DynamoDB] Erro ao consultar logs:', error.message);
    return res.json(localAuditLogs);
  }
});

// ----------------------------------------------------
// AUTENTICAÇÃO SIMPLES
// ----------------------------------------------------
app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (!EMAIL_RE.test(String(email))) {
    return res.status(400).json({ message: 'E-mail inválido.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const user = {
      id: `user-${crypto.randomUUID()}`,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      passwordHash: await hashPassword(String(password)),
      createdAt: new Date().toISOString()
    };
    if (!(await dbCreateUser(user))) {
      return res.status(409).json({ message: 'E-mail já cadastrado.' });
    }

    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ message: 'Usuário cadastrado com sucesso!', token, user: publicUser(user) });
  } catch (error) {
    return serverError(res, 'Erro ao cadastrar usuário.', error);
  }
});

app.post('/auth/admin', (req, res) => {
  const { password } = req.body || {};
  const ok = !ADMIN_PASSWORD || crypto.timingSafeEqual(sha256(password || ''), sha256(ADMIN_PASSWORD));
  if (!ok) {
    return res.status(401).json({ message: 'Senha de administrador inválida.' });
  }
  const token = jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  return res.json({ token, protected: !!ADMIN_PASSWORD });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
  }
  try {
    const user = await dbFindUserByEmail(String(email).trim().toLowerCase());
    if (!user || !(await verifyPassword(String(password), user.passwordHash))) {
      return res.status(401).json({ message: 'Credenciais inválidas.' });
    }
    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ message: 'Login realizado com sucesso!', token, user: publicUser(user) });
  } catch (error) {
    return serverError(res, 'Erro ao autenticar.', error);
  }
});

// Compatibilidade transitória com rotas antigas de produtos
app.get('/products', async (req, res) => {
  try {
    res.json(await dbListEvents());
  } catch (error) {
    serverError(res, 'Erro ao listar eventos.', error);
  }
});

// Tratamento de erros (upload inválido, JSON malformado etc.)
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError || err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'JSON inválido.' });
  }
  return serverError(res, 'Erro interno do servidor.', err);
});

// Inicialização de serviços
async function bootstrap() {
  if (!getPgConfig()) ensureDirectories();
  await connectRedis();
  await ensureRelationalSchema();
}

bootstrapPromise = bootstrap();
bootstrapPromise.catch((err) => {
  // Sem schema não há aplicação: falhar alto faz o systemd reiniciar e o ALB tirar a instância de rotação.
  console.error('[Bootstrap] Falha ao inicializar o banco relacional:', err.message);
  if (IS_PROD) process.exit(1);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API em execução na porta ${PORT}`);
  });
}

module.exports = app;
