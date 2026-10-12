// AMAZON RDS (PostgreSQL) - conexão, pool e criação do esquema.
// Quando o RDS está configurado ele é a ÚNICA fonte de verdade: se o banco falhar a API retorna erro,
// em vez de gravar em arquivos locais (o que geraria estoque divergente entre as instâncias do ASG).
const fs = require('node:fs');
const { Pool } = require('pg');
const { SCHEMA_FILE } = require('../config');
const { seedEvents } = require('./seedEvents');

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

const isConfigured = () => !!getPgConfig();

let pgPool = null;

// Retorna o pool compartilhado, ou null quando não há RDS configurado (modo desenvolvimento).
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
  const ddl = fs.readFileSync(SCHEMA_FILE, 'utf8');

  // Advisory lock: várias instâncias do ASG sobem juntas e não podem criar/semear o schema ao mesmo tempo.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(ddl);

    // Semeia os jogos iniciais quando o banco está vazio
    const count = await client.query('SELECT COUNT(*)::int AS n FROM events');
    if (count.rows[0].n === 0) {
      for (const ev of seedEvents()) {
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

module.exports = { isConfigured, getPool, ensureRelationalSchema };
