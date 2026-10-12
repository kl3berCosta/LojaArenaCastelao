// MODEL de jogos: acesso a dados no RDS (ou store local em desenvolvimento, sem RDS).
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');

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

async function findAll() {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM events ORDER BY event_date ASC');
    return result.rows.map(rowToEvent);
  }
  return loadStore().events;
}

async function findById(id) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    return result.rows.length ? rowToEvent(result.rows[0]) : null;
  }
  return loadStore().events.find((e) => e.id === id) || null;
}

async function create(eventData) {
  const pool = db.getPool();
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

const COLUMNS = {
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
// `undefined` = não alterar; `null` = limpar o campo.
async function update(id, updates) {
  const fields = Object.keys(updates).filter((k) => COLUMNS[k] && updates[k] !== undefined);

  const pool = db.getPool();
  if (pool) {
    if (fields.length === 0) return findById(id);
    const sets = fields.map((k, i) => `${COLUMNS[k]} = $${i + 1}`);
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

// Retorna o jogo removido, ou null se não existia.
async function remove(id) {
  const existing = await findById(id);
  if (!existing) return null;

  const pool = db.getPool();
  if (pool) {
    await pool.query('DELETE FROM events WHERE id = $1', [id]);
    return existing;
  }

  const store = loadStore();
  store.events = store.events.filter((e) => e.id !== id);
  saveStore(store);
  return existing;
}

module.exports = { findAll, findById, create, update, remove };
