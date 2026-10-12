const express = require('express');
const controller = require('./auth.controller');

const router = express.Router();

router.post('/admin', controller.adminLogin);

module.exports = router;
