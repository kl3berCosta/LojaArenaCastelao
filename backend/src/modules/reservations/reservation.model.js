// MODEL de reservas temporárias do checkout.
// Reservar tira os ingressos do estoque do setor por alguns minutos (padrão: 10). Se a compra não for
// confirmada a tempo, a reserva expira e o estoque volta. Tudo em transações no RDS: duas pessoas
// nunca reservam o mesmo ingresso, e uma reserva nunca é devolvida duas vezes.
const crypto = require('node:crypto');
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');

// Lido a cada uso (os testes encurtam o prazo)
const ttlSeconds = () => Math.max(1, Number(process.env.RESERVATION_TTL_SECONDS) || 600);

function rowToReservation(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    sectorId: row.sector_id,
    sectorName: row.sector_name,
    customerEmail: row.customer_email,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    total: Number(row.unit_price) * Number(row.quantity),
    status: row.status,
    expiresAt: row.expires_at
  };
}

// Encerra reservas ativas que casam com `where` e devolve o estoque aos setores, numa única instrução.
// O `status = 'active'` no UPDATE garante que cada reserva é devolvida uma única vez, mesmo com
// várias instâncias rodando a limpeza ao mesmo tempo. Retorna os ids dos jogos afetados.
async function releaseWhere(client, newStatus, where, params) {
  const result = await client.query(
    `WITH rel AS (
       UPDATE reservations SET status = '${newStatus}'
       WHERE status = 'active' AND ${where}
       RETURNING sector_id, quantity
     ), agg AS (
       SELECT sector_id, SUM(quantity) AS qty FROM rel GROUP BY sector_id
     )
     UPDATE sectors s SET available = s.available + agg.qty
     FROM agg WHERE s.id = agg.sector_id
     RETURNING s.event_id`,
    params
  );
  return [...new Set(result.rows.map((r) => r.event_id))];
}

// --- versão em memória (desenvolvimento sem RDS) ---
function localRelease(store, newStatus, predicate) {
  const eventIds = new Set();
  for (const r of store.reservations) {
    if (r.status !== 'active' || !predicate(r)) continue;
    r.status = newStatus;
    const ev = store.events.find((e) => e.id === r.eventId);
    const sector = ev && (ev.sectors || []).find((s) => s.id === r.sectorId);
    if (sector) sector.available += r.quantity;
    eventIds.add(r.eventId);
  }
  return [...eventIds];
}

// Devolve ao estoque as reservas vencidas (chamado pelo worker periodicamente e antes de reservar).
async function releaseExpired() {
  const pool = db.getPool();
  if (pool) return releaseWhere(pool, 'expired', 'expires_at < NOW()', []);

  const store = loadStore();
  const now = Date.now();
  const ids = localRelease(store, 'expired', (r) => new Date(r.expiresAt).getTime() < now);
  if (ids.length) saveStore(store);
  return ids;
}

// Cria a reserva. Antes, cancela outras reservas ativas do mesmo cliente (evita acumular ingressos
// "presos" em várias abas). Retorna { reservation, releasedEventIds } ou { error: 'not_found' | 'sold_out' }.
async function create({ eventId, sectorId, quantity, email }) {
  const id = `res-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + ttlSeconds() * 1000);

  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const released = await releaseWhere(client, 'cancelled', 'customer_email = $1', [email]);

      const taken = await client.query(
        `UPDATE sectors SET available = available - $1
         WHERE id = $2 AND event_id = $3 AND available >= $1
         RETURNING *`,
        [quantity, sectorId, eventId]
      );
      if (taken.rows.length === 0) {
        await client.query('ROLLBACK');
        const exists = await pool.query('SELECT 1 FROM sectors WHERE id = $1 AND event_id = $2', [sectorId, eventId]);
        return { error: exists.rows.length ? 'sold_out' : 'not_found' };
      }
      const sector = taken.rows[0];
      await client.query(
        `INSERT INTO reservations (id, event_id, sector_id, customer_email, quantity, unit_price, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)`,
        [id, eventId, sectorId, email, quantity, sector.price, expiresAt]
      );
      await client.query('COMMIT');
      return {
        releasedEventIds: released,
        reservation: rowToReservation({
          id, event_id: eventId, sector_id: sectorId, sector_name: sector.name, customer_email: email,
          quantity, unit_price: sector.price, status: 'active', expires_at: expiresAt.toISOString()
        })
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const store = loadStore();
  const released = localRelease(store, 'cancelled', (r) => r.customerEmail === email);
  const ev = store.events.find((e) => e.id === eventId);
  const sector = ev && (ev.sectors || []).find((s) => s.id === sectorId);
  if (!sector) {
    saveStore(store);
    return { error: 'not_found' };
  }
  if (sector.available < quantity) {
    saveStore(store);
    return { error: 'sold_out' };
  }
  sector.available -= quantity;
  const reservation = {
    id, eventId, sectorId, sectorName: sector.name, customerEmail: email, quantity,
    unitPrice: sector.price, total: sector.price * quantity, status: 'active', expiresAt: expiresAt.toISOString()
  };
  store.reservations.push(reservation);
  saveStore(store);
  return { releasedEventIds: released, reservation };
}

// Cancelamento pelo próprio cliente (voltou do checkout). Retorna o id do jogo, ou null se não havia reserva ativa.
async function cancel(id, email) {
  const pool = db.getPool();
  if (pool) {
    const ids = await releaseWhere(pool, 'cancelled', 'id = $1 AND customer_email = $2', [id, email]);
    return ids[0] || null;
  }
  const store = loadStore();
  const ids = localRelease(store, 'cancelled', (r) => r.id === id && r.customerEmail === email);
  if (ids.length) saveStore(store);
  return ids[0] || null;
}

module.exports = { ttlSeconds, releaseExpired, create, cancel, rowToReservation, localRelease };
