const express = require('express');
const { requireAdmin } = require('../../middlewares/auth');
const upload = require('../../middlewares/upload');
const controller = require('./event.controller');

const router = express.Router();

router.get('/', controller.list);
router.get('/:id', controller.getOne);
router.post('/', requireAdmin, upload.single('banner'), controller.create);
router.put('/:id', requireAdmin, upload.single('banner'), controller.update);
router.delete('/:id', requireAdmin, controller.remove);

module.exports = router;
