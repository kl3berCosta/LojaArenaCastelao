// CONTROLLER de pedidos.
const Order = require('./order.model');
const { logCrudAction } = require('../audit/audit.model');
const { invalidateCache } = require('../../lib/cache');
const { serverError } = require('../../lib/http');
const { MAX_TICKETS_PER_ORDER } = require('../../config');

// POST /orders - compra de ingressos (requer usuário logado; nome e e-mail vêm do token)
async function create(req, res) {
  const { eventId } = req.body || {};
  const quantity = Number(req.body?.quantity);

  if (!eventId || typeof eventId !== 'string') {
    return res.status(400).json({ message: 'ID do evento é obrigatório.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
    return res.status(400).json({ message: `Quantidade deve ser um inteiro entre 1 e ${MAX_TICKETS_PER_ORDER}.` });
  }

  try {
    const result = await Order.purchase(eventId, quantity, req.user.name, req.user.email);

    if (!result.success) {
      return res.status(result.notFound ? 404 : 409).json({ message: result.reason });
    }

    await logCrudAction('ORDER', 'order', result.order);
    // Invalida o cache do jogo para refletir o estoque restante
    await invalidateCache(['events:list', `events:${eventId}`]);

    return res.status(201).json({ message: 'Compra realizada com sucesso!', order: result.order });
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
