const express = require('express');
const { requireAdmin, requireUser } = require('../../middlewares/auth');
const controller = require('./order.controller');

const router = express.Router();

router.post('/', requireUser, controller.create);
router.get('/mine', requireUser, controller.listMine); // ingressos do próprio usuário
router.get('/', requireAdmin, controller.list);

module.exports = router;
