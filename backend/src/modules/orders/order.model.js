// MODEL de pedidos: compra com controle de concorrência no RDS (ou store local em desenvolvimento).
const crypto = require('node:crypto');
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');

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

// Compra atômica: o UPDATE condicional e a trava de linha serializam compradores simultâneos do
// mesmo jogo, então nunca se vende mais do que o estoque.
// Retorna { success, order } ou { success: false, notFound?, reason }.
async function purchase(eventId, quantity, customerName, customerEmail) {
  const pool = db.getPool();
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

  const order = {
    id: `order-${crypto.randomUUID()}`,
    eventId,
    eventName: `${event.teamHome} x ${event.teamAway}`,
    customerName,
    customerEmail,
    quantity,
    total: Number(event.price) * quantity,
    status: 'confirmed',
    createdAt: new Date().toISOString()
  };

  event.available -= quantity;
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

module.exports = { purchase, findAll, findByCustomer };
