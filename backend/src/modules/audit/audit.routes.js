const express = require('express');
const { requireAdmin } = require('../../middlewares/auth');
const controller = require('./audit.controller');

const router = express.Router();

router.get('/', requireAdmin, controller.list);

module.exports = router;
