// CONTROLLER de usuários (clientes): cadastro e login com JWT.
const crypto = require('node:crypto');
const User = require('./user.model');
const { hashPassword, verifyPassword } = require('./password');
const { signUserToken } = require('../../middlewares/auth');
const { serverError } = require('../../lib/http');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /auth/register
async function register(req, res) {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, e-mail e senha são obrigatórios.' });
  }
  if (!EMAIL_RE.test(String(email))) {
    return res.status(400).json({ message: 'E-mail inválido.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  try {
    const user = {
      id: `user-${crypto.randomUUID()}`,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      passwordHash: await hashPassword(String(password)),
      createdAt: new Date().toISOString()
    };
    if (!(await User.create(user))) {
      return res.status(409).json({ message: 'E-mail já cadastrado.' });
    }

    return res.status(201).json({
      message: 'Usuário cadastrado com sucesso!',
      token: signUserToken(user),
      user: User.toPublic(user)
    });
  } catch (error) {
    return serverError(res, 'Erro ao cadastrar usuário.', error);
  }
}

// POST /auth/login
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'E-mail e senha são obrigatórios.' });
  }
  try {
    const user = await User.findByEmail(String(email).trim().toLowerCase());
    if (!user || !(await verifyPassword(String(password), user.passwordHash))) {
      return res.status(401).json({ message: 'Credenciais inválidas.' });
    }
    return res.json({
      message: 'Login realizado com sucesso!',
      token: signUserToken(user),
      user: User.toPublic(user)
    });
  } catch (error) {
    return serverError(res, 'Erro ao autenticar.', error);
  }
}

module.exports = { register, login };
