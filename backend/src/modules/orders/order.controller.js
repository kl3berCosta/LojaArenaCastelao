// CONTROLLER de pedidos.
const Order = require('./order.model');
const Event = require('../events/event.model');
const { logCrudAction } = require('../audit/audit.model');
const { invalidateCache } = require('../../lib/cache');
const queue = require('../../lib/queue');
const { putMetric } = require('../../lib/metrics');
const { serverError } = require('../../lib/http');
const { MAX_TICKETS_PER_ORDER } = require('../../config');

// Publica PEDIDO_CONFIRMADO (SNS -> fan-out para as filas de PDF e de e-mail).
// A compra já está gravada: uma falha aqui não desfaz a venda, só fica registrada.
async function publishConfirmed(order) {
  try {
    const event = await Event.findById(order.eventId);
    const info = await queue.publishOrderConfirmed({
      order,
      event: event && {
        id: event.id, teamHome: event.teamHome, teamAway: event.teamAway, stadium: event.stadium, date: event.date
      }
    });
    return info.provider;
  } catch (error) {
    console.error('[SNS] Falha ao publicar PEDIDO_CONFIRMADO:', error);
    await logCrudAction('ORDER_EVENT_FAILED', 'order', { orderId: order.id, reason: error.message });
    return null;
  }
}

// POST /orders - compra (requer usuário logado; nome e e-mail vêm do token)
//  { reservationId }                     -> confirma a reserva do checkout
//  { eventId, quantity, sectorId? }      -> compra direta (API / teste de carga)
async function create(req, res) {
  const { reservationId, eventId, sectorId } = req.body || {};

  let result;
  try {
    if (reservationId) {
      if (typeof reservationId !== 'string') return res.status(400).json({ message: 'Reserva inválida.' });
      result = await Order.purchaseReservation({
        reservationId, customerName: req.user.name, customerEmail: req.user.email
      });
      if (result.releasedEventId) {
        await invalidateCache(['events:list', `events:${result.releasedEventId}`]);
      }
    } else {
      const quantity = Number(req.body?.quantity);
      if (!eventId || typeof eventId !== 'string') {
        return res.status(400).json({ message: 'ID do evento é obrigatório.' });
      }
      if (sectorId !== undefined && typeof sectorId !== 'string') {
        return res.status(400).json({ message: 'Setor inválido.' });
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
        return res.status(400).json({ message: `Quantidade deve ser um inteiro entre 1 e ${MAX_TICKETS_PER_ORDER}.` });
      }
      result = await Order.purchase({
        eventId, sectorId, quantity, customerName: req.user.name, customerEmail: req.user.email
      });
    }

    if (!result.success) {
      const status = result.code || (result.notFound ? 404 : 409);
      return res.status(status).json({ message: result.reason });
    }

    const { order } = result;
    await logCrudAction('ORDER', 'order', order);
    await invalidateCache(['events:list', `events:${order.eventId}`]);
    putMetric('Orders');
    putMetric('TicketsSold', order.quantity);
    putMetric('Revenue', order.total, 'None');
    const provider = await publishConfirmed(order);

    return res.status(201).json({
      message: 'Compra realizada com sucesso!',
      order,
      notifications: provider ? { published: true, provider } : { published: false }
    });
  } catch (error) {
    return serverError(res, 'Erro ao processar compra.', error);
  }
}

// GET /orders - listagem (admin)
async function list(req, res) {
  try {
    return res.json(await Order.findAll());
  } catch (error) {
    return serverError(res, 'Erro ao listar pedidos.', error);
  }
}

// GET /orders/mine - ingressos do usuário logado (nunca de outro cliente: o e-mail vem do token)
async function listMine(req, res) {
  try {
    const orders = await Order.findByCustomer(req.user.email);
    logCrudAction('READ', 'my-orders', { customerEmail: req.user.email, count: orders.length });
    return res.json(orders);
  } catch (error) {
    return serverError(res, 'Erro ao listar seus ingressos.', error);
  }
}

module.exports = { create, list, listMine };
