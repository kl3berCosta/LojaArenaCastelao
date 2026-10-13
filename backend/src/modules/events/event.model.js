// MODEL de jogos: acesso a dados no RDS (ou store local em desenvolvimento, sem RDS).
// Preço e estoque de um jogo vêm dos SETORES: `price` é o menor preço ("a partir de")
// e `available` é a soma do que resta em todos os setores.
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');
const { buildSectors } = require('../../lib/sectorTemplate');
const Sector = require('../sectors/sector.model');

function rowToEvent(row) {
  return {
    id: row.id,
    teamHome: row.team_home,
    teamAway: row.team_away,
    stadium: row.stadium,
    date: row.event_date,
    category: row.category,
    price: Number(row.min_price ?? row.price),
    available: Number(row.total_available ?? row.available),
    description: row.description,
    bannerUrl: row.banner_url,
    thumbnailUrl: row.thumbnail_url,
    processingStatus: row.processing_status,
    createdAt: row.created_at
  };
}

// Jogo do store local, com preço/estoque calculados a partir dos setores
function localView(ev, withSectors) {
  const sectors = ev.sectors || [];
  const view = {
    ...ev,
    price: sectors.length ? Math.min(...sectors.map((s) => s.price)) : ev.price,
    available: sectors.length ? sectors.reduce((sum, s) => sum + s.available, 0) : ev.available
  };
  if (withSectors) view.sectors = Sector.sortSectors(sectors);
  else delete view.sectors;
  return view;
}

const SELECT_WITH_TOTALS = `
  SELECT e.*, agg.min_price, agg.total_available
  FROM events e
  LEFT JOIN (
    SELECT event_id, MIN(price) AS min_price, SUM(available) AS total_available
    FROM sectors GROUP BY event_id
  ) agg ON agg.event_id = e.id`;

async function findAll() {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query(`${SELECT_WITH_TOTALS} ORDER BY e.event_date ASC`);
    return result.rows.map(rowToEvent);
  }
  return loadStore().events.map((ev) => localView(ev, false));
}

// Detalhe do jogo, incluindo os setores (usados no mapa do estádio)
async function findById(id) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query(`${SELECT_WITH_TOTALS} WHERE e.id = $1`, [id]);
    if (!result.rows.length) return null;
    return { ...rowToEvent(result.rows[0]), sectors: await Sector.findByEvent(id) };
  }
  const ev = loadStore().events.find((e) => e.id === id);
  return ev ? localView(ev, true) : null;
}

// Cria o jogo e os seus setores (a partir do preço base e da capacidade total) numa transação.
async function create(eventData) {
  const sectors = buildSectors(eventData.id, eventData.price, eventData.available);

  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
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
      await Sector.insertMany(client, sectors);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { ...eventData, sectors: Sector.sortSectors(sectors) };
  }

  const store = loadStore();
  store.events.unshift({ ...eventData, sectors });
  saveStore(store);
  return localView(store.events[0], true);
}

const COLUMNS = {
  teamHome: 'team_home',
  teamAway: 'team_away',
  stadium: 'stadium',
  date: 'event_date',
  category: 'category',
  description: 'description',
  bannerUrl: 'banner_url',
  thumbnailUrl: 'thumbnail_url',
  processingStatus: 'processing_status'
};

// Atualiza SOMENTE os campos informados (um UPDATE com todas as colunas sobrescreveria,
// por exemplo, o thumbnail gravado pelo worker). `undefined` = não alterar; `null` = limpar.
// Preço e estoque não são campos do jogo: são editados por setor (Sector.updateMany).
async function update(id, updates) {
  const fields = Object.keys(updates).filter((k) => COLUMNS[k] && updates[k] !== undefined);

  const pool = db.getPool();
  if (pool) {
    if (fields.length) {
      const sets = fields.map((k, i) => `${COLUMNS[k]} = $${i + 1}`);
      const result = await pool.query(
        `UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${fields.length + 1}`,
        [...fields.map((k) => updates[k]), id]
      );
      if (result.rowCount === 0) return null;
    }
    return findById(id);
  }

  const store = loadStore();
  const idx = store.events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const merged = { ...store.events[idx], updatedAt: new Date().toISOString() };
  for (const k of fields) merged[k] = updates[k];
  store.events[idx] = merged;
  saveStore(store);
  return localView(merged, true);
}

// Retorna o jogo removido, ou null se não existia. Os setores saem junto (ON DELETE CASCADE);
// os pedidos ficam, pois guardam o nome do jogo e do setor.
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
