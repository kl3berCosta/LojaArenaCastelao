const express = require('express');
const cors = require('cors');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const AWS = require('aws-sdk');
const { Client } = require('pg');
const Redis = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stadium-ticket-secret';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const awsRegion = process.env.AWS_REGION || 'us-east-1';

// AWS SDK Clients
// Os clientes são criados quando o recurso está configurado (variável do recurso).
// Na EC2 as credenciais vêm da IAM Role (instance profile), então NÃO dependemos de AWS_ACCESS_KEY_ID.
const s3 = process.env.S3_BUCKET_NAME ? new AWS.S3({ region: awsRegion }) : null;
const sqs = process.env.SQS_QUEUE_URL ? new AWS.SQS({ region: awsRegion }) : null;
const sns = process.env.SNS_TOPIC_ARN ? new AWS.SNS({ region: awsRegion }) : null;
const dynamodb = process.env.DYNAMODB_TABLE_NAME ? new AWS.DynamoDB.DocumentClient({ region: awsRegion }) : null;

// Multer para upload de imagens (memória para repassar para S3 ou disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

let redisClient = null;
const localAuditLogs = [];

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Garante estrutura de arquivos locais para fallback
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const rawDir = path.join(UPLOADS_DIR, 'banners', 'raw');
  const processedDir = path.join(UPLOADS_DIR, 'banners', 'processed');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const initialEvents = [
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

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ users: [], orders: [], events: initialEvents }, null, 2),
      'utf8'
    );
  }

  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function loadStore() {
  ensureDirectories();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
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
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'appdb',
      ssl: getPgSsl()
    };
  }
  return null;
}

async function getPgClient() {
  const config = getPgConfig();
  if (!config) return null;
  try {
    const client = new Client(config);
    await client.connect();
    return client;
  } catch (error) {
    console.warn('[RDS PostgreSQL] Conexão falhou:', error.message);
    return null;
  }
}

async function ensureRelationalSchema() {
  const client = await getPgClient();
  if (!client) return;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id VARCHAR(100) PRIMARY KEY,
        team_home VARCHAR(100) NOT NULL,
        team_away VARCHAR(100) NOT NULL,
        stadium VARCHAR(150) NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        category VARCHAR(100) DEFAULT 'Arquibancada',
        price NUMERIC(10,2) NOT NULL DEFAULT 100.00,
        available INTEGER NOT NULL DEFAULT 100,
        description TEXT,
        banner_url TEXT,
        thumbnail_url TEXT,
        processing_status VARCHAR(50) DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id VARCHAR(100) PRIMARY KEY,
        event_id VARCHAR(100) NOT NULL,
        event_name VARCHAR(200) NOT NULL,
        customer_name VARCHAR(150) NOT NULL,
        customer_email VARCHAR(150) NOT NULL,
        quantity INTEGER NOT NULL,
        total NUMERIC(10,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'confirmed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Semeia os jogos iniciais quando o banco está vazio (ON CONFLICT evita duplicar com várias instâncias)
    const count = await client.query('SELECT COUNT(*)::int AS n FROM events');
    if (count.rows[0].n === 0) {
      for (const ev of loadStore().events || []) {
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
  } catch (error) {
    console.warn('[RDS PostgreSQL] Erro ao sincronizar schema:', error.message);
  } finally {
    await client.end();
  }
}

// ----------------------------------------------------
// 2. AMAZON ELASTICACHE (Redis) - Camada de Cache
// ----------------------------------------------------
async function connectRedis() {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);
  if (!redisUrl) return null;

  try {
    redisClient = Redis.createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.warn('[ElastiCache Redis] Aviso:', err.message));
    await redisClient.connect();
    console.log('[ElastiCache Redis] Conectado com sucesso.');
    return redisClient;
  } catch (error) {
    console.warn('[ElastiCache Redis] Erro ao conectar:', error.message);
    return null;
  }
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
    const fresh = await fetcher();
    if (fresh !== null && fresh !== undefined) {
      await redis.set(key, JSON.stringify(fresh), { EX: ttlSeconds });
    }
    return fresh;
  } catch (error) {
    console.warn(`[ElastiCache Redis] Erro ao buscar cache de ${key}:`, error.message);
    return fetcher();
  }
}

async function invalidateCache(keys = ['events:list']) {
  const redis = await connectRedis();
  if (!redis) return;

  try {
    for (const key of keys) {
      await redis.del(key);
    }
  } catch (error) {
    console.warn('[ElastiCache Redis] Erro ao invalidar cache:', error.message);
  }
}

// ----------------------------------------------------
// 3. AMAZON DYNAMODB - Auditoria NoSQL de Ações do CRUD
// ----------------------------------------------------
async function logCrudAction(action, resource, payload) {
  const logEntry = {
    id: crypto.randomUUID(),
    action,
    resource,
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  };

  localAuditLogs.unshift(logEntry);
  if (localAuditLogs.length > 100) localAuditLogs.pop();

  if (dynamodb && process.env.DYNAMODB_TABLE_NAME) {
    try {
      await dynamodb.put({
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: logEntry
      }).promise();
      return logEntry;
    } catch (error) {
      console.warn('[DynamoDB] Erro ao salvar log de auditoria:', error.message);
    }
  }

  return logEntry;
}

// ----------------------------------------------------
// 4. AMAZON S3 - Armazenamento de Arquivos Binários
// ----------------------------------------------------
async function uploadToS3(buffer, originalName, subfolder = 'banners/raw') {
  const extension = path.extname(originalName) || '.jpg';
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`;

  if (s3 && process.env.S3_BUCKET_NAME) {
    const key = `${subfolder}/${fileName}`;
    await s3.putObject({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
      ACL: 'public-read'
    }).promise();

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
  fs.writeFileSync(localTarget, buffer);

  return {
    url: `/uploads/${subfolder}/${fileName}`,
    localPath: localTarget,
    fileName
  };
}

// ----------------------------------------------------
// 5. AMAZON SNS / SQS - Desacoplamento Assíncrono (Req. 6)
// ----------------------------------------------------
async function enqueueBannerTask(taskPayload) {
  const message = {
    type: 'RESCALE_BANNER',
    ...taskPayload,
    enqueuedAt: new Date().toISOString()
  };

  // 1. Tenta fila Amazon SQS
  if (sqs && process.env.SQS_QUEUE_URL) {
    await sqs.sendMessage({
      QueueUrl: process.env.SQS_QUEUE_URL,
      MessageBody: JSON.stringify(message)
    }).promise();
    return { provider: 'Amazon SQS', enqueued: true };
  }

  // 2. Tenta Amazon SNS Topic
  if (sns && process.env.SNS_TOPIC_ARN) {
    await sns.publish({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Subject: 'Process Banner Task',
      Message: JSON.stringify(message)
    }).promise();
    return { provider: 'Amazon SNS', enqueued: true };
  }

  // 3. Fallback fila local (arquivo queue.json lido pelo worker)
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

// ----------------------------------------------------
// OPERAÇÕES DE DADOS (RDS com Fallback Store)
// ----------------------------------------------------
async function dbListEvents() {
  const pg = await getPgClient();
  if (pg) {
    try {
      const result = await pg.query('SELECT * FROM events ORDER BY event_date ASC');
      await pg.end();
      return result.rows.map((row) => ({
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
      }));
    } catch (err) {
      console.warn('[RDS] Erro ao listar eventos, usando store:', err.message);
      if (pg) await pg.end();
    }
  }

  const store = loadStore();
  return store.events || [];
}

async function dbGetEventById(id) {
  const pg = await getPgClient();
  if (pg) {
    try {
      const result = await pg.query('SELECT * FROM events WHERE id = $1', [id]);
      await pg.end();
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
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
    } catch (err) {
      console.warn('[RDS] Erro ao buscar evento por ID, usando store:', err.message);
      if (pg) await pg.end();
    }
  }

  const store = loadStore();
  return (store.events || []).find((e) => e.id === id) || null;
}

async function dbCreateEvent(eventData) {
  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(
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
          Number(eventData.price),
          Number(eventData.available),
          eventData.description || '',
          eventData.bannerUrl || null,
          eventData.thumbnailUrl || null,
          eventData.processingStatus || 'completed'
        ]
      );
      await pg.end();
    } catch (err) {
      console.warn('[RDS] Erro ao inserir evento no banco:', err.message);
      if (pg) await pg.end();
    }
  }

  // Grava também no store local
  const store = loadStore();
  store.events.unshift(eventData);
  saveStore(store);

  return eventData;
}

async function dbUpdateEvent(id, updates) {
  const existing = await dbGetEventById(id);
  if (!existing) return null;

  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };

  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query(
        `UPDATE events 
         SET team_home = $1, team_away = $2, stadium = $3, event_date = $4, category = $5,
             price = $6, available = $7, description = $8, banner_url = $9, thumbnail_url = $10,
             processing_status = $11, updated_at = NOW()
         WHERE id = $12`,
        [
          merged.teamHome,
          merged.teamAway,
          merged.stadium,
          merged.date,
          merged.category,
          Number(merged.price),
          Number(merged.available),
          merged.description,
          merged.bannerUrl,
          merged.thumbnailUrl,
          merged.processingStatus,
          id
        ]
      );
      await pg.end();
    } catch (err) {
      console.warn('[RDS] Erro ao atualizar evento:', err.message);
      if (pg) await pg.end();
    }
  }

  const store = loadStore();
  const idx = store.events.findIndex((e) => e.id === id);
  if (idx !== -1) {
    store.events[idx] = merged;
    saveStore(store);
  }

  return merged;
}

async function dbDeleteEvent(id) {
  const existing = await dbGetEventById(id);
  if (!existing) return null;

  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query('DELETE FROM events WHERE id = $1', [id]);
      await pg.end();
    } catch (err) {
      console.warn('[RDS] Erro ao deletar evento:', err.message);
      if (pg) await pg.end();
    }
  }

  const store = loadStore();
  store.events = store.events.filter((e) => e.id !== id);
  saveStore(store);

  return existing;
}

// Compra com controle de concorrência no RDS
async function dbPurchaseTickets(eventId, quantity, customerName, customerEmail) {
  const pg = await getPgClient();
  if (pg) {
    try {
      await pg.query('BEGIN');
      // Decrementa de forma atômica se houver saldo suficiente
      const updateResult = await pg.query(
        `UPDATE events 
         SET available = available - $1, updated_at = NOW()
         WHERE id = $2 AND available >= $1
         RETURNING *`,
        [quantity, eventId]
      );

      if (updateResult.rows.length === 0) {
        await pg.query('ROLLBACK');
        await pg.end();
        return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente.' };
      }

      const eventRow = updateResult.rows[0];
      const total = Number(eventRow.price) * quantity;
      const orderId = `order-${Date.now()}`;
      const eventName = `${eventRow.team_home} x ${eventRow.team_away}`;

      await pg.query(
        `INSERT INTO orders (id, event_id, event_name, customer_name, customer_email, quantity, total, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', NOW())`,
        [orderId, eventId, eventName, customerName, customerEmail, quantity, total]
      );

      await pg.query('COMMIT');
      await pg.end();

      const order = {
        id: orderId,
        eventId,
        eventName,
        customerName,
        customerEmail,
        quantity,
        total,
        status: 'confirmed',
        createdAt: new Date().toISOString()
      };

      // Atualiza store local
      const store = loadStore();
      store.orders.unshift(order);
      const storeEv = store.events.find((e) => e.id === eventId);
      if (storeEv) storeEv.available = Number(eventRow.available);
      saveStore(store);

      return { success: true, order, event: eventRow };
    } catch (err) {
      console.warn('[RDS] Erro na transação de compra:', err.message);
      if (pg) {
        await pg.query('ROLLBACK').catch(() => {});
        await pg.end();
      }
    }
  }

  // Fallback local no store.json
  const store = loadStore();
  const event = store.events.find((e) => e.id === eventId);
  if (!event) return { success: false, reason: 'Evento não encontrado.' };
  if (event.available < quantity) return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente.' };

  const total = Number(event.price) * quantity;
  const order = {
    id: `order-${Date.now()}`,
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

// ----------------------------------------------------
// ACESSO ADMINISTRATIVO
// Se ADMIN_PASSWORD estiver definido, as rotas de CRUD/auditoria exigem token de admin.
// Sem ADMIN_PASSWORD (desenvolvimento local/testes) as rotas ficam abertas.
// ----------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'admin') return next();
  } catch (err) {
    // token ausente/inválido
  }
  return res.status(401).json({ message: 'Acesso restrito ao administrador.' });
}

// ----------------------------------------------------
// ROTAS DA API
// ----------------------------------------------------

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

// 2. Rota para teste de estresse de CPU (Parte 2 - Demonstração Auto Scaling)
app.get('/stress', (req, res) => {
  const durationMs = Math.min(Number(req.query.duration || 10000), 60000);
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
    const events = await getCached('events:list', async () => dbListEvents(), 60);
    res.json(events);
  } catch (error) {
    res.status(500).json({ message: 'Erro ao listar eventos.', error: error.message });
  }
});

// 4. Detalhes de um Evento (com log de auditoria no DynamoDB)
app.get('/events/:id', async (req, res) => {
  try {
    const event = await getCached(`events:${req.params.id}`, async () => dbGetEventById(req.params.id), 60);
    if (!event) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    await logCrudAction('READ', 'event', { eventId: event.id, eventName: `${event.teamHome} x ${event.teamAway}` });
    res.json(event);
  } catch (error) {
    res.status(500).json({ message: 'Erro ao buscar evento.', error: error.message });
  }
});

// 5. Criação de Evento com Upload de Imagem e Desacoplamento via SQS/SNS
app.post('/events', requireAdmin, upload.single('banner'), async (req, res) => {
  const { teamHome, teamAway, stadium, date, price, available, category, description } = req.body || {};

  if (!teamHome || !teamAway || !stadium || !date || !price) {
    return res.status(400).json({ message: 'Campos obrigatórios: time mandante, visitante, estádio, data e preço.' });
  }

  try {
    const eventId = `match-${Date.now()}`;
    let bannerUrl = req.body.bannerUrl || null;
    let s3Info = null;

    // Se houve envio de imagem binária
    if (req.file) {
      s3Info = await uploadToS3(req.file.buffer, req.file.originalname, 'banners/raw');
      bannerUrl = s3Info.url;
    }

    const newEvent = {
      id: eventId,
      teamHome,
      teamAway,
      stadium,
      date: new Date(date).toISOString(),
      category: category || 'Arquibancada',
      price: Number(price),
      available: Number(available || 100),
      description: description || '',
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

    // 4. Se tiver imagem, DESACOPLA o processamento enviando tarefa para o SQS/SNS
    let queueInfo = null;
    if (req.file) {
      queueInfo = await enqueueBannerTask({
        eventId,
        bannerUrl,
        s3Bucket: s3Info?.bucket,
        s3Key: s3Info?.key,
        localFilePath: s3Info?.localPath,
        imageBase64: !s3Info?.bucket ? req.file.buffer.toString('base64') : null,
        fileName: req.file.originalname
      });
    }

    return res.status(201).json({
      message: 'Evento cadastrado com sucesso!',
      event: newEvent,
      decoupledProcessing: queueInfo ? { enqueued: true, provider: queueInfo.provider } : null
    });
  } catch (error) {
    console.error('Erro ao cadastrar evento:', error);
    return res.status(500).json({ message: 'Erro ao criar evento.', error: error.message });
  }
});

// 6. Atualização de Evento (CRUD Update)
app.put('/events/:id', requireAdmin, upload.single('banner'), async (req, res) => {
  try {
    const existing = await dbGetEventById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Evento não encontrado.' });
    }

    const updates = { ...req.body };
    if (updates.price) updates.price = Number(updates.price);
    if (updates.available) updates.available = Number(updates.available);

    let s3Info = null;
    if (req.file) {
      s3Info = await uploadToS3(req.file.buffer, req.file.originalname, 'banners/raw');
      updates.bannerUrl = s3Info.url;
      updates.processingStatus = 'pending';
    }

    const updated = await dbUpdateEvent(req.params.id, updates);

    // Auditoria no DynamoDB
    await logCrudAction('UPDATE', 'event', updated);

    // Invalida cache no Redis
    await invalidateCache(['events:list', `events:${req.params.id}`]);

    // Enfileira processamento no SQS se imagem foi alterada
    if (req.file) {
      await enqueueBannerTask({
        eventId: updated.id,
        bannerUrl: updated.bannerUrl,
        s3Bucket: s3Info?.bucket,
        s3Key: s3Info?.key,
        localFilePath: s3Info?.localPath,
        imageBase64: !s3Info?.bucket ? req.file.buffer.toString('base64') : null,
        fileName: req.file.originalname
      });
    }

    return res.json({
      message: 'Evento atualizado com sucesso!',
      event: updated
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao atualizar evento.', error: error.message });
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
    return res.status(500).json({ message: 'Erro ao excluir evento.', error: error.message });
  }
});

// 8. Compra de Ingressos (Orders) com controle de estoque concorrente
app.post('/orders', async (req, res) => {
  const { eventId, quantity, customerName, customerEmail } = req.body || {};

  if (!eventId || !quantity || Number(quantity) <= 0) {
    return res.status(400).json({ message: 'ID do evento e quantidade válida são obrigatórios.' });
  }

  const name = customerName || 'Cliente Torcedor';
  const email = customerEmail || 'torcedor@email.com';

  try {
    const result = await dbPurchaseTickets(eventId, Number(quantity), name, email);

    if (!result.success) {
      return res.status(409).json({ message: result.reason });
    }

    // Auditoria da compra no DynamoDB
    await logCrudAction('CREATE', 'order', result.order);

    // Invalida cache do evento no Redis para refletir estoque restante
    await invalidateCache(['events:list', `events:${eventId}`]);

    return res.status(201).json({
      message: 'Compra realizada com sucesso!',
      order: result.order
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro ao processar compra.', error: error.message });
  }
});

// 9. Listagem de Pedidos
app.get('/orders', requireAdmin, async (req, res) => {
  const pg = await getPgClient();
  if (pg) {
    try {
      const result = await pg.query('SELECT * FROM orders ORDER BY created_at DESC');
      await pg.end();
      return res.json(result.rows);
    } catch (err) {
      if (pg) await pg.end();
    }
  }
  const store = loadStore();
  return res.json(store.orders || []);
});

// 10. Listagem de Logs de Auditoria do DynamoDB (Para avaliação)
app.get('/audit-logs', requireAdmin, async (req, res) => {
  if (dynamodb && process.env.DYNAMODB_TABLE_NAME) {
    try {
      const scanResult = await dynamodb.scan({
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Limit: 50
      }).promise();
      return res.json(scanResult.Items || []);
    } catch (err) {
      console.warn('[DynamoDB] Erro ao consultar logs:', err.message);
    }
  }
  return res.json(localAuditLogs);
});

// ----------------------------------------------------
// AUTENTICAÇÃO SIMPLES
// ----------------------------------------------------
app.post('/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
  }
  const store = loadStore();
  if (store.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ message: 'E-mail já cadastrado.' });
  }
  const user = {
    id: `user-${Date.now()}`,
    name,
    email: email.toLowerCase(),
    passwordHash: crypto.createHash('sha256').update(`${password}:${JWT_SECRET}`).digest('hex'),
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  saveStore(store);

  const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  return res.status(201).json({ message: 'Usuário cadastrado com sucesso!', token, user });
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

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
  }
  const store = loadStore();
  const hash = crypto.createHash('sha256').update(`${password}:${JWT_SECRET}`).digest('hex');
  const user = store.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase() && u.passwordHash === hash);
  if (!user) {
    return res.status(401).json({ message: 'Credenciais inválidas.' });
  }
  const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  return res.json({ message: 'Login realizado com sucesso!', token, user });
});

// Compatibilidade transitória com rotas antigas de produtos
app.get('/products', async (req, res) => {
  const events = await dbListEvents();
  res.json(events);
});

// Inicialização de serviços
async function bootstrap() {
  ensureDirectories();
  await connectRedis();
  await ensureRelationalSchema();
}

bootstrap().catch((err) => {
  console.warn('[Bootstrap] Aviso:', err.message);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API em execução na porta ${PORT}`);
  });
}

module.exports = app;
