// CONTROLLER de reservas temporárias (checkout).
const Reservation = require('./reservation.model');
const { logCrudAction } = require('../audit/audit.model');
const { invalidateCache } = require('../../lib/cache');
const { putMetric } = require('../../lib/metrics');
const { serverError } = require('../../lib/http');
const { MAX_TICKETS_PER_ORDER } = require('../../config');

const eventKeys = (ids) => ['events:list', ...ids.map((id) => `events:${id}`)];

// POST /reservations { eventId, sectorId, quantity } - separa os ingressos por alguns minutos
async function create(req, res) {
  const { eventId, sectorId } = req.body || {};
  const quantity = Number(req.body?.quantity);
  if (!eventId || !sectorId || typeof eventId !== 'string' || typeof sectorId !== 'string') {
    return res.status(400).json({ message: 'Jogo e setor são obrigatórios.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_ORDER) {
    return res.status(400).json({ message: `Quantidade deve ser um inteiro entre 1 e ${MAX_TICKETS_PER_ORDER}.` });
  }

  try {
    // Libera reservas vencidas antes, para quem chega agora disputar o estoque real
    const expired = await Reservation.releaseExpired();
    const result = await Reservation.create({ eventId, sectorId, quantity, email: req.user.email });
    const touched = [...expired, ...(result.releasedEventIds || []), eventId];
    await invalidateCache(eventKeys([...new Set(touched)]));

    if (result.error === 'not_found') return res.status(404).json({ message: 'Jogo ou setor não encontrado.' });
    if (result.error === 'sold_out') return res.status(409).json({ message: 'Não há ingressos suficientes neste setor.' });

    await logCrudAction('CREATE', 'reservation', result.reservation);
    putMetric('ReservationsCreated');
    return res.status(201).json({
      message: 'Ingressos reservados. Conclua a compra antes do prazo.',
      reservation: result.reservation,
      ttlSeconds: Reservation.ttlSeconds()
    });
  } catch (error) {
    return serverError(res, 'Erro ao reservar ingressos.', error);
  }
}

// DELETE /reservations/:id - o cliente desistiu (voltou do checkout): o estoque volta na hora
async function cancel(req, res) {
  try {
    const eventId = await Reservation.cancel(req.params.id, req.user.email);
    if (!eventId) return res.status(404).json({ message: 'Reserva ativa não encontrada.' });
    await invalidateCache(eventKeys([eventId]));
    await logCrudAction('DELETE', 'reservation', { reservationId: req.params.id, customerEmail: req.user.email });
    return res.json({ message: 'Reserva cancelada.' });
  } catch (error) {
    return serverError(res, 'Erro ao cancelar a reserva.', error);
  }
}

module.exports = { create, cancel };
