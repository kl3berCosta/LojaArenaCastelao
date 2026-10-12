// CONTROLLER do acesso administrativo (senha única definida em ADMIN_PASSWORD).
const crypto = require('node:crypto');
const { ADMIN_PASSWORD } = require('../../config');
const { signAdminToken } = require('../../middlewares/auth');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

// POST /auth/admin
function adminLogin(req, res) {
  const { password } = req.body || {};
  // Compara os digests em tempo constante para não vazar o tamanho/prefixo da senha.
  const ok = !ADMIN_PASSWORD || crypto.timingSafeEqual(sha256(password || ''), sha256(ADMIN_PASSWORD));
  if (!ok) {
    return res.status(401).json({ message: 'Senha de administrador inválida.' });
  }
  return res.json({ token: signAdminToken(), protected: !!ADMIN_PASSWORD });
}

module.exports = { adminLogin };
