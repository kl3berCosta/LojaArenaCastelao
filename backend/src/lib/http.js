const { IS_PROD } = require('../config');

// Resposta 500 padronizada: registra o erro no servidor e só expõe detalhes fora de produção.
function serverError(res, message, error) {
  console.error(`[API] ${message}`, error);
  const body = { message };
  if (!IS_PROD && error) body.error = error.message;
  return res.status(500).json(body);
}

module.exports = { serverError };
