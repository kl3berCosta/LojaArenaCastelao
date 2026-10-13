const path = require('node:path');
const crypto = require('node:crypto');

const BACKEND_DIR = path.join(__dirname, '..', '..');

// Pastas do modo desenvolvimento; podem ser trocadas por variável de ambiente (os testes usam uma pasta temporária).
const DATA_DIR = process.env.DATA_DIR || path.join(BACKEND_DIR, 'data');

const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Em produção os segredos são obrigatórios: nunca subimos com admin aberto ou JWT previsível.
if (IS_PROD && (!ADMIN_PASSWORD || !process.env.JWT_SECRET)) {
  throw new Error('ADMIN_PASSWORD e JWT_SECRET são obrigatórios quando NODE_ENV=production.');
}

module.exports = {
  IS_PROD,
  PORT: process.env.PORT || 3000,
  ADMIN_PASSWORD,
  // Fora de produção, sem JWT_SECRET usamos um segredo aleatório por processo (tokens não sobrevivem a restart).
  JWT_SECRET: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  MAX_TICKETS_PER_ORDER: 10,
  // Endereço público do site (o do ALB na AWS), usado nos links enviados por e-mail
  APP_PUBLIC_URL: (process.env.APP_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),

  // Pastas usadas somente no modo desenvolvimento (sem AWS/RDS configurados)
  BACKEND_DIR,
  DATA_DIR,
  DATA_FILE: path.join(DATA_DIR, 'store.json'),
  QUEUE_FILE: path.join(DATA_DIR, 'queue.json'),
  UPLOADS_DIR: process.env.UPLOADS_DIR || path.join(BACKEND_DIR, 'uploads'),
  FRONTEND_DIR: path.join(BACKEND_DIR, '..', 'frontend'),
  SCHEMA_FILE: path.join(BACKEND_DIR, 'schema.sql')
};
