// MODEL de setores do estádio (preço e estoque por setor de cada jogo).
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');
const { SECTOR_TEMPLATE } = require('../../lib/sectorTemplate');

const ORDER = SECTOR_TEMPLATE.map((t) => t.code);
const sortSectors = (list) => [...list].sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));

function rowToSector(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    code: row.code,
    name: row.name,
    price: Number(row.price),
    capacity: Number(row.capacity),
    available: Number(row.available)
  };
}

async function findByEvent(eventId) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM sectors WHERE event_id = $1', [eventId]);
    return sortSectors(result.rows.map(rowToSector));
  }
  const ev = loadStore().events.find((e) => e.id === eventId);
  return ev ? sortSectors(ev.sectors || []) : [];
}

// Usado dentro da transação de criação do jogo
async function insertMany(client, sectors) {
  for (const s of sectors) {
    await client.query(
      `INSERT INTO sectors (id, event_id, code, name, price, capacity, available)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.id, s.eventId, s.code, s.name, s.price, s.capacity, s.available]
    );
  }
}

// Edição pelo admin: [{ id, price?, available? }]. `available` é o que resta à venda;
// a capacidade acompanha para nunca ficar menor que o disponível.
// Retorna a lista atualizada, ou null se algum setor não pertence ao jogo.
async function updateMany(eventId, changes) {
  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of changes) {
        const result = await client.query(
          `UPDATE sectors
           SET price = COALESCE($1, price),
               available = COALESCE($2, available),
               capacity = GREATEST(capacity, COALESCE($2, available))
           WHERE id = $3 AND event_id = $4`,
          [c.price ?? null, c.available ?? null, c.id, eventId]
        );
        if (result.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return findByEvent(eventId);
  }

  const store = loadStore();
  const ev = store.events.find((e) => e.id === eventId);
  if (!ev) return null;
  for (const c of changes) {
    const s = (ev.sectors || []).find((x) => x.id === c.id);
    if (!s) return null;
    if (c.price !== undefined) s.price = c.price;
    if (c.available !== undefined) {
      s.available = c.available;
      s.capacity = Math.max(s.capacity, c.available);
    }
  }
  saveStore(store);
  return sortSectors(ev.sectors);
}

module.exports = { findByEvent, insertMany, updateMany, sortSectors, rowToSector };
