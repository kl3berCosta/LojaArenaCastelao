const express = require('express');
const controller = require('./ticket.controller');

const router = express.Router();

router.get('/:id/download', controller.download); // link enviado por e-mail

module.exports = router;
