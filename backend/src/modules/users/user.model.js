// MODEL de usuários: RDS (ou store local em desenvolvimento, sem RDS).
const db = require('../../lib/db');
const { loadStore, saveStore } = require('../../lib/localStore');

async function findByEmail(email) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return { id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash };
  }
  return loadStore().users.find((u) => u.email === email) || null;
}

// Retorna false se o e-mail já existe.
async function create(user) {
  const pool = db.getPool();
  if (pool) {
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [user.id, user.name, user.email, user.passwordHash]
    );
    return result.rowCount === 1;
  }
  const store = loadStore();
  if (store.users.some((u) => u.email === user.email)) return false;
  store.users.push(user);
  saveStore(store);
  return true;
}

// Nunca expõe o hash da senha
const toPublic = (u) => ({ id: u.id, name: u.name, email: u.email });

module.exports = { findByEmail, create, toPublic };
