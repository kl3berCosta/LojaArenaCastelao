const express = require('express');
const { requireAdmin } = require('../../middlewares/auth');
const controller = require('./system.controller');

const router = express.Router();

router.get('/health', controller.health);
router.get('/stress', requireAdmin, controller.stress);
router.get('/admin/elasticity', requireAdmin, controller.elasticity);

module.exports = router;
