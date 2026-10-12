const jwt = require('jsonwebtoken');
const { ADMIN_PASSWORD, JWT_SECRET } = require('../config');

function signUserToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function signAdminToken() {
  return jwt.sign({ sub: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

// Se ADMIN_PASSWORD estiver definido, as rotas de escrita/auditoria exigem token de admin.
// Sem ADMIN_PASSWORD (apenas desenvolvimento local/testes) ficam abertas;
// em produção o servidor nem sobe sem ADMIN_PASSWORD (ver config).
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const payload = readToken(req);
  if (payload && payload.role === 'admin') return next();
  return res.status(401).json({ message: 'Acesso restrito ao administrador.' });
}

// Exige um usuário logado (token de cliente) e disponibiliza req.user.
function requireUser(req, res, next) {
  const payload = readToken(req);
  if (payload && payload.email && payload.role !== 'admin') {
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    return next();
  }
  return res.status(401).json({ message: 'Faça login para comprar ingressos.' });
}

module.exports = { signUserToken, signAdminToken, requireAdmin, requireUser };
