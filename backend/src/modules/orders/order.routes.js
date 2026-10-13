const express = require('express');
const { requireAdmin, requireUser } = require('../../middlewares/auth');
const controller = require('./order.controller');
const ticketController = require('../tickets/ticket.controller');

const router = express.Router();

router.post('/', requireUser, controller.create);
router.get('/mine', requireUser, controller.listMine); // ingressos do próprio usuário
router.get('/:id/ticket', requireUser, ticketController.getMine); // PDF do próprio ingresso
router.get('/', requireAdmin, controller.list);

module.exports = router;
