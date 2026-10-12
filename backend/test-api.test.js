const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./server.js');
const worker = require('./worker.js');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      console.log(`[Test] Servidor de teste ouvindo em ${baseUrl}`);
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

let userToken;
async function getUserToken() {
  if (userToken) return userToken;
  const res = await fetchJson('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Torcedor Fiel', email: `torcedor-${Date.now()}@email.com`, password: 'senha-segura' })
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.passwordHash, undefined, 'Resposta não pode expor o hash da senha');
  userToken = res.body.token;
  return userToken;
}

const authJson = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

test('GET /health responde status ok e informa os serviços AWS', async () => {
  const res = await fetchJson('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.awsServices);
  assert.ok('ec2' in res.body.awsServices);
  assert.ok('rds' in res.body.awsServices);
  assert.ok('elasticache' in res.body.awsServices);
  assert.ok('s3' in res.body.awsServices);
  assert.ok('dynamodb' in res.body.awsServices);
  assert.ok('sqsSns' in res.body.awsServices);
});

test('GET /events lista eventos disponíveis', async () => {
  const res = await fetchJson('/events');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  const first = res.body[0];
  assert.ok(first.teamHome);
  assert.ok(first.teamAway);
  assert.ok(first.price);
  assert.ok(first.available > 0);
});

test('POST /events cadastra novo evento e enfileira tarefa de banner', async () => {
  const res = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamHome: 'Ceará SC',
      teamAway: 'Fortaleza EC',
      stadium: 'Arena Castelão',
      date: '2026-11-10T16:00:00',
      price: 80.00,
      available: 500,
      category: 'Cadeira Especial',
      description: 'Clássico-Rei cearense'
    })
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.message, 'Evento cadastrado com sucesso!');
  assert.equal(res.body.event.teamHome, 'Ceará SC');
  assert.equal(res.body.event.available, 500);
});

test('POST /orders realiza compra e decrementa disponibilidade', async () => {
  const eventsBefore = await fetchJson('/events');
  const targetEvent = eventsBefore.body[0];
  const initialAvailable = targetEvent.available;

  const token = await getUserToken();
  const buyRes = await fetchJson('/orders', {
    method: 'POST',
    headers: authJson(token),
    body: JSON.stringify({ eventId: targetEvent.id, quantity: 2 })
  });

  assert.equal(buyRes.status, 201);
  assert.equal(buyRes.body.message, 'Compra realizada com sucesso!');
  assert.equal(buyRes.body.order.quantity, 2);
  assert.equal(buyRes.body.order.total, targetEvent.price * 2);

  // Valida que o estoque diminuiu
  const eventsAfter = await fetchJson('/events');
  const updatedEvent = eventsAfter.body.find((e) => e.id === targetEvent.id);
  assert.equal(updatedEvent.available, initialAvailable - 2);
});

test('POST /orders exige login e valida a quantidade', async () => {
  const events = await fetchJson('/events');
  const eventId = events.body[0].id;

  const anon = await fetchJson('/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, quantity: 1 })
  });
  assert.equal(anon.status, 401);

  const token = await getUserToken();
  for (const quantity of [0, -1, 1.5, 'abc', 999]) {
    const bad = await fetchJson('/orders', {
      method: 'POST',
      headers: authJson(token),
      body: JSON.stringify({ eventId, quantity })
    });
    assert.equal(bad.status, 400, `quantity=${quantity} deveria ser rejeitada`);
  }

  const missing = await fetchJson('/orders', {
    method: 'POST',
    headers: authJson(token),
    body: JSON.stringify({ eventId: 'nao-existe', quantity: 1 })
  });
  assert.equal(missing.status, 404);
});

test('Compras concorrentes nunca vendem mais do que o estoque e geram pedidos distintos', async () => {
  const created = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamHome: 'A', teamAway: 'B', stadium: 'Arena Castelão', date: '2026-12-01T16:00:00', price: 10, available: 5
    })
  });
  const eventId = created.body.event.id;
  const token = await getUserToken();

  const results = await Promise.all(Array.from({ length: 12 }, () => fetchJson('/orders', {
    method: 'POST',
    headers: authJson(token),
    body: JSON.stringify({ eventId, quantity: 1 })
  })));

  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  assert.equal(new Set(ok.map((r) => r.body.order.id)).size, 5, 'ids de pedido devem ser únicos');

  const after = await fetchJson(`/events/${eventId}`);
  assert.equal(after.body.available, 0);
});

test('POST/PUT /events validam entrada e PUT ignora campos fora da lista permitida', async () => {
  const badDate = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamHome: 'A', teamAway: 'B', stadium: 'X', date: 'isto-nao-e-data', price: 10 })
  });
  assert.equal(badDate.status, 400);

  const created = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamHome: 'C', teamAway: 'D', stadium: 'X', date: '2026-12-02T16:00:00', price: 20, available: 10 })
  });
  const id = created.body.event.id;

  const put = await fetchJson(`/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'sequestrado', price: 25, available: 0, processingStatus: 'hack' })
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.event.id, id);
  assert.equal(put.body.event.price, 25);
  assert.equal(put.body.event.available, 0);
  assert.notEqual(put.body.event.processingStatus, 'hack');

  const badPut = await fetchJson(`/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: -5 })
  });
  assert.equal(badPut.status, 400);
});

test('Upload de banner rejeita arquivos que não são imagem', async () => {
  const form = new FormData();
  form.append('teamHome', 'A');
  form.append('teamAway', 'B');
  form.append('stadium', 'X');
  form.append('date', '2026-12-03T16:00:00');
  form.append('price', '10');
  form.append('banner', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
  const res = await fetch(`${baseUrl}/events`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

test('Login usa hash seguro e rejeita senha errada', async () => {
  const email = `login-${Date.now()}@email.com`;
  const reg = await fetchJson('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Maria', email, password: 'minha-senha' })
  });
  assert.equal(reg.status, 201);

  const dup = await fetchJson('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Maria', email: email.toUpperCase(), password: 'minha-senha' })
  });
  assert.equal(dup.status, 409);

  const ok = await fetchJson('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'minha-senha' })
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.passwordHash, undefined);

  const bad = await fetchJson('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'errada' })
  });
  assert.equal(bad.status, 401);
});

test('GET /audit-logs retorna histórico de ações do CRUD (NoSQL DynamoDB)', async () => {
  const res = await fetchJson('/audit-logs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  const hasCreate = res.body.some((log) => log.action === 'CREATE');
  assert.ok(hasCreate, 'Deveria conter ação CREATE registrada nos logs');
  assert.ok(res.body.some((log) => log.action === 'ORDER'), 'Deveria conter ação ORDER (compra) nos logs');
  assert.ok(res.body.every((log) => log.timestamp && log.payload), 'Todo log precisa de ação, dados e horário');
});

test('GET /stress executa carga de CPU com sucesso', async () => {
  const res = await fetchJson('/stress?duration=200');
  assert.equal(res.status, 200);
  assert.ok(res.body.message.includes('Carga de CPU executada'));
});

test('Worker desacoplado processa tarefas da fila assíncrona', async () => {
  // Cria uma tarefa de redimensionamento na fila
  const testImageBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const task = {
    eventId: 'match-1',
    fileName: 'pixel.png',
    imageBase64: testImageBuffer.toString('base64'),
    bannerUrl: 'local/pixel.png'
  };

  const processed = await worker.processMessage(task);
  assert.equal(processed, true);

  // Verifica se o evento teve seu thumbnail_url atualizado
  const eventRes = await fetchJson('/events/match-1');
  assert.equal(eventRes.status, 200);
  assert.ok(eventRes.body.thumbnailUrl, 'Thumbnail deve ter sido preenchido pelo worker');
  assert.equal(eventRes.body.processingStatus, 'completed');
});
