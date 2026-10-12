const multer = require('multer');
const { serverError } = require('../lib/http');

// Tratamento de erros globais (upload inválido, JSON malformado etc.)
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError || err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ message: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'JSON inválido.' });
  }
  return serverError(res, 'Erro interno do servidor.', err);
}

module.exports = errorHandler;
