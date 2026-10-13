// CONTROLLER de usuários (clientes): cadastro e login com JWT.
const crypto = require('node:crypto');
const User = require('./user.model');
const { hashPassword, verifyPassword } = require('./password');
const { signUserToken } = require('../../middlewares/auth');
const { serverError } = require('../../lib/http');
const notifier = require('../../lib/notifier');

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

    // Assina o e-mail no tópico SNS de notificações (a AWS envia um e-mail de confirmação).
    // Falha aqui não impede o cadastro: o cliente pode pedir de novo em "Meus ingressos".
    let emailNotifications = 'none';
    try {
      emailNotifications = (await notifier.subscribe(user.email)).status;
    } catch (err) {
      console.warn('[SNS] Não foi possível assinar o e-mail do cliente:', err.message);
    }

    return res.status(201).json({
      message: 'Usuário cadastrado com sucesso!',
      token: signUserToken(user),
      user: User.toPublic(user),
      emailNotifications
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

// GET /users/me/email-notifications - situação da assinatura de e-mail do cliente
async function emailStatus(req, res) {
  try {
    return res.json({ status: await notifier.subscriptionStatus(req.user.email) });
  } catch (error) {
    return serverError(res, 'Erro ao consultar as notificações por e-mail.', error);
  }
}

// POST /users/me/email-notifications - (re)envia o e-mail de confirmação da AWS
async function emailSubscribe(req, res) {
  try {
    const current = await notifier.subscriptionStatus(req.user.email);
    if (current === 'confirmed' || current === 'local') return res.json({ status: current });
    const { status } = await notifier.subscribe(req.user.email);
    return res.status(202).json({ status, message: 'Enviamos um e-mail da AWS: clique em "Confirm subscription" para receber seus ingressos.' });
  } catch (error) {
    return serverError(res, 'Erro ao ativar as notificações por e-mail.', error);
  }
}

module.exports = { register, login, emailStatus, emailSubscribe };
