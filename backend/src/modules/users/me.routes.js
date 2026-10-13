const express = require('express');
const { requireUser } = require('../../middlewares/auth');
const controller = require('./user.controller');

const router = express.Router();

router.get('/email-notifications', requireUser, controller.emailStatus);
router.post('/email-notifications', requireUser, controller.emailSubscribe);

module.exports = router;
