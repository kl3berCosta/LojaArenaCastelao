// AMAZON ELASTICACHE (Redis) - Camada de Cache.
// O cache é opcional: se o Redis estiver fora do ar, a API segue direto no RDS.
const Redis = require('redis');

let redisClient = null;
let redisConnecting = null;
let redisRetryAfter = 0;

async function connectRedis() {
  if (redisClient) {
    // Cliente já criado: ele mesmo se reconecta; enquanto não estiver pronto, ignoramos o cache.
    return redisClient.isReady ? redisClient : null;
  }

  const redisUrl = process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : null);
  if (!redisUrl) return null;
  if (Date.now() < redisRetryAfter) return null;

  if (!redisConnecting) {
    redisConnecting = (async () => {
      let everReady = false;
      const client = Redis.createClient({
        url: redisUrl,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 3000,
          // Na conexão inicial desiste rápido; depois de conectado reconecta para sempre.
          reconnectStrategy: (retries) => (!everReady && retries >= 2 ? new Error('Redis indisponível') : Math.min(retries * 200 + 100, 3000))
        }
      });
      client.on('error', (err) => console.warn('[ElastiCache Redis] Aviso:', err.message));
      client.on('ready', () => { everReady = true; });
      try {
        await client.connect();
        redisClient = client;
        console.log('[ElastiCache Redis] Conectado com sucesso.');
        return client;
      } catch (error) {
        console.warn('[ElastiCache Redis] Erro ao conectar:', error.message);
        redisRetryAfter = Date.now() + 15000;
        try { client.destroy(); } catch (_) { /* já fechado */ }
        return null;
      } finally {
        redisConnecting = null;
      }
    })();
  }
  return redisConnecting;
}

// Padrão cache-aside: lê do Redis; se não houver, busca com `fetcher` e grava com TTL.
async function getCached(key, fetcher, ttlSeconds = 60) {
  const redis = await connectRedis();
  if (!redis) {
    return fetcher();
  }

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn(`[ElastiCache Redis] Erro ao ler cache de ${key}:`, error.message);
    return fetcher();
  }

  const fresh = await fetcher();
  if (fresh !== null && fresh !== undefined) {
    try {
      await redis.set(key, JSON.stringify(fresh), { EX: ttlSeconds });
    } catch (error) {
      console.warn(`[ElastiCache Redis] Erro ao gravar cache de ${key}:`, error.message);
    }
  }
  return fresh;
}

async function invalidateCache(keys = ['events:list']) {
  const redis = await connectRedis();
  if (!redis) return;

  try {
    await redis.del(keys);
    console.log(`[ElastiCache Redis] Cache invalidado: ${keys.join(', ')}`);
  } catch (error) {
    console.warn('[ElastiCache Redis] Erro ao invalidar cache:', error.message);
  }
}

async function closeRedis() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit().catch(() => {});
  }
}

module.exports = { connectRedis, getCached, invalidateCache, closeRedis };
