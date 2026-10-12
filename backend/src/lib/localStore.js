// Armazenamento em arquivo: APENAS modo desenvolvimento, quando não há RDS configurado.
// Com o RDS configurado nada aqui é usado como fonte de dados.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, DATA_FILE, QUEUE_FILE, UPLOADS_DIR } = require('../config');
const { seedEvents } = require('./seedEvents');

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'processed'), { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ users: [], orders: [], events: seedEvents() }, null, 2),
      'utf8'
    );
  }

  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function loadStore() {
  ensureDirectories();
  try {
    const store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    store.users = store.users || [];
    store.orders = store.orders || [];
    store.events = store.events || [];
    return store;
  } catch (error) {
    return { users: [], orders: [], events: [] };
  }
}

function saveStore(store) {
  ensureDirectories();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
}

// Fila local de tarefas (substitui SNS/SQS em desenvolvimento)
function pushLocalTask(message) {
  ensureDirectories();
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  queue.push(message);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function pullLocalTask() {
  if (!fs.existsSync(QUEUE_FILE)) return null;
  try {
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(queue) && queue.length > 0) {
      const task = queue.shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
      return task;
    }
  } catch (err) {
    console.warn('[Fila local] Erro ao ler fila:', err.message);
  }
  return null;
}

module.exports = { ensureDirectories, loadStore, saveStore, pushLocalTask, pullLocalTask };
