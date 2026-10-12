const db = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const { ensureDirectories } = require('./lib/localStore');

// Inicialização dos serviços: Redis (opcional) e esquema do RDS. Sem RDS, prepara o store local (dev).
async function bootstrap() {
  if (!db.isConfigured()) ensureDirectories();
  await connectRedis();
  await db.ensureRelationalSchema();
}

module.exports = bootstrap;
