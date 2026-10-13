// MODEL de pedidos: compra com controle de concorrência no RDS (ou store local em desenvolvimento).
// Há dois caminhos:
//  - purchaseReservation: confirma uma reserva do checkout (o estoque já foi separado ao reservar);
//  - purchase: compra direta num setor (API, testes e teste de carga), com baixa atômica do estoque.
const crypto = require('node:crypto');
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');
const { localRelease } = require('../reservations/reservation.model');

function rowToOrder(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    eventName: row.event_name,
    sectorId: row.sector_id || null,
    sectorName: row.sector_name || null,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    quantity: row.quantity,
    unitPrice: row.unit_price != null ? Number(row.unit_price) : null,
    total: Number(row.total),
    status: row.status,
    ticketStatus: row.ticket_status || 'pending',
    createdAt: row.created_at
  };
}

const newOrderId = () => `order-${crypto.randomUUID()}`;

async function insertOrder(client, o) {
  await client.query(
    `INSERT INTO orders (id, event_id, event_name, sector_id, sector_name, unit_price, customer_name, customer_email,
                         quantity, total, status, ticket_status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', 'pending', NOW())`,
    [o.id, o.eventId, o.eventName, o.sectorId, o.sectorName, o.unitPrice, o.customerName, o.customerEmail, o.quantity, o.total]
  );
}

function buildOrder({ eventId, eventName, sector, quantity, customerName, customerEmail }) {
  const unitPrice = Number(sector.price);
  return {
    id: newOrderId(),
    eventId,
    eventName,
    sectorId: sector.id,
    sectorName: sector.name,
    unitPrice,
    customerName,
    customerEmail,
    quantity,
    total: Math.round(unitPrice * quantity * 100) / 100,
    status: 'confirmed',
    ticketStatus: 'pending',
    createdAt: new Date().toISOString()
  };
}

// Compra direta: baixa atômica no setor informado (ou no setor mais barato, se nenhum for informado).
// O UPDATE condicional e a trava de linha serializam compradores simultâneos: nunca vende além do estoque.
// Retorna { success, order } ou { success: false, notFound?, reason }.
async function purchase({ eventId, sectorId, quantity, customerName, customerEmail }) {
  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let targetSector = sectorId;
      if (!targetSector) {
        const cheapest = await client.query(
          'SELECT id FROM sectors WHERE event_id = $1 ORDER BY price ASC, code ASC LIMIT 1',
          [eventId]
        );
        targetSector = cheapest.rows[0]?.id;
      }

      const updated = targetSector
        ? await client.query(
          `UPDATE sectors SET available = available - $1
           WHERE id = $2 AND event_id = $3 AND available >= $1
           RETURNING *`,
          [quantity, targetSector, eventId]
        )
        : { rows: [] };

      if (updated.rows.length === 0) {
        await client.query('ROLLBACK');
        const exists = await pool.query('SELECT 1 FROM sectors WHERE id = $1 AND event_id = $2', [targetSector || '', eventId]);
        if (!exists.rows.length) return { success: false, notFound: true, reason: 'Jogo ou setor não encontrado.' };
        return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente neste setor.' };
      }

      const ev = await client.query('SELECT team_home, team_away FROM events WHERE id = $1', [eventId]);
      const order = buildOrder({
        eventId,
        eventName: `${ev.rows[0].team_home} x ${ev.rows[0].team_away}`,
        sector: updated.rows[0],
        quantity,
        customerName,
        customerEmail
      });
      await insertOrder(client, order);
      await client.query('UPDATE events SET updated_at = NOW() WHERE id = $1', [eventId]);
      await client.query('COMMIT');
      return { success: true, order };
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
  const sectors = event ? [...(event.sectors || [])] : [];
  const sector = sectorId
    ? sectors.find((s) => s.id === sectorId)
    : sectors.sort((a, b) => a.price - b.price || a.code.localeCompare(b.code))[0];
  if (!event || !sector) return { success: false, notFound: true, reason: 'Jogo ou setor não encontrado.' };
  if (sector.available < quantity) return { success: false, reason: 'Ingressos esgotados ou saldo insuficiente neste setor.' };

  sector.available -= quantity;
  const order = buildOrder({
    eventId, eventName: `${event.teamHome} x ${event.teamAway}`, sector, quantity, customerName, customerEmail
  });
  store.orders.unshift(order);
  saveStore(store);
  return { success: true, order };
}

// Confirma a reserva do checkout. Só o dono da reserva pode confirmá-la, e só dentro do prazo.
// Retorna { success, order } ou { success: false, code: 404|409|410, reason }.
async function purchaseReservation({ reservationId, customerName, customerEmail }) {
  const pool = db.getPool();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT r.*, (r.expires_at < NOW()) AS is_expired, s.name AS sector_name, s.price AS sector_price,
                e.team_home, e.team_away
         FROM reservations r
         JOIN sectors s ON s.id = r.sector_id
         JOIN events e ON e.id = r.event_id
         WHERE r.id = $1 AND r.customer_email = $2
         FOR UPDATE OF r`,
        [reservationId, customerEmail]
      );
      const r = found.rows[0];
      if (!r) {
        await client.query('ROLLBACK');
        return { success: false, code: 404, reason: 'Reserva não encontrada.' };
      }
      if (r.status !== 'active') {
        await client.query('ROLLBACK');
        return r.status === 'expired'
          ? { success: false, code: 410, reason: 'Sua reserva expirou. Escolha os ingressos novamente.' }
          : { success: false, code: 409, reason: 'Esta reserva já foi usada ou cancelada.' };
      }
      if (r.is_expired) {
        // Venceu e a limpeza ainda não passou: devolve o estoque agora mesmo
        await client.query("UPDATE reservations SET status = 'expired' WHERE id = $1", [r.id]);
        await client.query('UPDATE sectors SET available = available + $1 WHERE id = $2', [r.quantity, r.sector_id]);
        await client.query('COMMIT');
        return { success: false, code: 410, reason: 'Sua reserva expirou. Escolha os ingressos novamente.', releasedEventId: r.event_id };
      }

      const order = buildOrder({
        eventId: r.event_id,
        eventName: `${r.team_home} x ${r.team_away}`,
        sector: { id: r.sector_id, name: r.sector_name, price: r.unit_price },
        quantity: Number(r.quantity),
        customerName,
        customerEmail
      });
      await client.query("UPDATE reservations SET status = 'converted' WHERE id = $1", [r.id]);
      await insertOrder(client, order);
      await client.query('COMMIT');
      return { success: true, order };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const store = loadStore();
  const r = store.reservations.find((x) => x.id === reservationId && x.customerEmail === customerEmail);
  if (!r) return { success: false, code: 404, reason: 'Reserva não encontrada.' };
  if (r.status === 'active' && new Date(r.expiresAt).getTime() < Date.now()) {
    localRelease(store, 'expired', (x) => x.id === r.id);
    saveStore(store);
    return { success: false, code: 410, reason: 'Sua reserva expirou. Escolha os ingressos novamente.', releasedEventId: r.eventId };
  }
  if (r.status !== 'active') {
    return r.status === 'expired'
      ? { success: false, code: 410, reason: 'Sua reserva expirou. Escolha os ingressos novamente.' }
      : { success: false, code: 409, reason: 'Esta reserva já foi usada ou cancelada.' };
  }
  const event = store.events.find((e) => e.id === r.eventId);
  const order = buildOrder({
    eventId: r.eventId,
    eventName: event ? `${event.teamHome} x ${event.teamAway}` : 'Jogo',
    sector: { id: r.sectorId, name: r.sectorName, price: r.unitPrice },
    quantity: r.quantity,
    customerName,
    customerEmail
  });
  r.status = 'converted';
  store.orders.unshift(order);
  saveStore(store);
  return { success: true, order };
}

async function findAll() {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    return result.rows.map(rowToOrder);
  }
  return loadStore().orders;
}

async function findById(id) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    return result.rows.length ? rowToOrder(result.rows[0]) : null;
  }
  return loadStore().orders.find((o) => o.id === id) || null;
}

// Marcado pelo worker quando o PDF do ingresso fica pronto no S3
async function setTicketStatus(id, status) {
  const pool = db.getPool();
  if (pool) {
    await pool.query('UPDATE orders SET ticket_status = $1 WHERE id = $2', [status, id]);
    return;
  }
  const store = loadStore();
  const o = store.orders.find((x) => x.id === id);
  if (o) {
    o.ticketStatus = status;
    saveStore(store);
  }
}

// Ingressos de um cliente (pelo e-mail do token), do mais recente ao mais antigo, com os dados do jogo.
// O jogo pode ter sido excluído depois da compra: nesse caso `event` vem null e o pedido continua válido.
async function findByCustomer(email) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT o.*, e.id AS ev_id, e.team_home, e.team_away, e.stadium, e.event_date, e.category,
              e.banner_url, e.thumbnail_url
       FROM orders o
       LEFT JOIN events e ON e.id = o.event_id
       WHERE o.customer_email = $1
       ORDER BY o.created_at DESC`,
      [email]
    );
    return result.rows.map((row) => ({
      ...rowToOrder(row),
      event: row.ev_id
        ? {
          id: row.ev_id,
          teamHome: row.team_home,
          teamAway: row.team_away,
          stadium: row.stadium,
          date: row.event_date,
          category: row.category,
          imageUrl: row.thumbnail_url || row.banner_url || null
        }
        : null
    }));
  }

  const store = loadStore();
  return store.orders
    .filter((o) => o.customerEmail === email)
    .map((o) => {
      const e = store.events.find((ev) => ev.id === o.eventId);
      return {
        ...o,
        event: e
          ? {
            id: e.id,
            teamHome: e.teamHome,
            teamAway: e.teamAway,
            stadium: e.stadium,
            date: e.date,
            category: e.category,
            imageUrl: e.thumbnailUrl || e.bannerUrl || null
          }
          : null
      };
    });
}

module.exports = { purchase, purchaseReservation, findAll, findById, setTicketStatus, findByCustomer };
