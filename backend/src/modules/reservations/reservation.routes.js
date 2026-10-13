const express = require('express');
const { requireUser } = require('../../middlewares/auth');
const controller = require('./reservation.controller');

const router = express.Router();

router.post('/', requireUser, controller.create);
router.delete('/:id', requireUser, controller.cancel);

module.exports = router;
