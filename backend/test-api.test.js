const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolamento: cada execução usa pastas temporárias próprias (modo local), então os testes
// não dependem de sobras de execuções anteriores e não sujam backend/data nem backend/uploads.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ingressos-test-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.UPLOADS_DIR = path.join(tmpRoot, 'uploads');

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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
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
      teamHome: 'A', teamAway: 'B', stadium: 'Arena Castelão', date: '2026-12-01T16:00:00', price: 10, available: 20
    })
  });
  const eventId = created.body.event.id;
  const sector = created.body.event.sectors.find((x) => x.code === 'norte');
  const stock = sector.available;
  assert.ok(stock > 0 && stock < 12, 'o setor precisa de menos ingressos do que compradores');
  const token = await getUserToken();

  const results = await Promise.all(Array.from({ length: 12 }, () => fetchJson('/orders', {
    method: 'POST',
    headers: authJson(token),
    body: JSON.stringify({ eventId, sectorId: sector.id, quantity: 1 })
  })));

  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, stock);
  assert.equal(results.filter((r) => r.status === 409).length, 12 - stock);
  assert.equal(new Set(ok.map((r) => r.body.order.id)).size, stock, 'ids de pedido devem ser únicos');
  assert.ok(ok.every((r) => r.body.order.sectorName === 'Arquibancada Norte'));

  const after = await fetchJson(`/events/${eventId}`);
  assert.equal(after.body.sectors.find((x) => x.code === 'norte').available, 0);
  assert.equal(after.body.available, 20 - stock, 'os outros setores não são afetados');
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

  const sectors = created.body.event.sectors;
  assert.equal(sectors.length, 4, 'jogo novo ganha os 4 setores padrão');
  const put = await fetchJson(`/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'sequestrado',
      processingStatus: 'hack',
      sectors: sectors.map((x) => ({ id: x.id, price: x.code === 'norte' ? 15 : x.price, available: 0 }))
    })
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.event.id, id);
  assert.equal(put.body.event.price, 15, 'o preço do jogo é o menor preço entre os setores');
  assert.equal(put.body.event.available, 0, 'o estoque do jogo é a soma dos setores');
  assert.notEqual(put.body.event.processingStatus, 'hack');

  const foreign = await fetchJson(`/events/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectors: [{ id: 'match-1-norte', available: 999 }] })
  });
  assert.equal(foreign.status, 400, 'não pode editar setor de outro jogo');

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

test('GET /orders/mine mostra só os ingressos do próprio usuário', async () => {
  const register = async (name) => {
    const res = await fetchJson('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: `${name.toLowerCase()}-${Date.now()}@email.com`, password: 'senha-segura' })
    });
    assert.equal(res.status, 201);
    return res.body.token;
  };
  const ana = await register('Ana');
  const bruno = await register('Bruno');

  const anon = await fetchJson('/orders/mine');
  assert.equal(anon.status, 401);

  const empty = await fetchJson('/orders/mine', { headers: authJson(ana) });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);

  const created = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamHome: 'Time Casa', teamAway: 'Time Fora', stadium: 'Arena Castelão', date: '2026-12-10T16:00:00', price: 50, available: 20 })
  });
  const target = created.body.event;
  const buy = await fetchJson('/orders', {
    method: 'POST',
    headers: authJson(ana),
    body: JSON.stringify({ eventId: target.id, quantity: 3 })
  });
  assert.equal(buy.status, 201);

  const mine = await fetchJson('/orders/mine', { headers: authJson(ana) });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].id, buy.body.order.id);
  assert.equal(mine.body[0].quantity, 3);
  assert.equal(mine.body[0].customerName, 'Ana');
  assert.equal(mine.body[0].event.teamHome, target.teamHome, 'deve trazer os dados do jogo');
  assert.equal(mine.body[0].event.stadium, target.stadium);

  const others = await fetchJson('/orders/mine', { headers: authJson(bruno) });
  assert.deepEqual(others.body, [], 'outro usuário não pode ver os ingressos da Ana');

  // Compras mais novas aparecem primeiro
  const buy2 = await fetchJson('/orders', {
    method: 'POST',
    headers: authJson(ana),
    body: JSON.stringify({ eventId: target.id, quantity: 1 })
  });
  const mine2 = await fetchJson('/orders/mine', { headers: authJson(ana) });
  assert.equal(mine2.body.length, 2);
  assert.equal(mine2.body[0].id, buy2.body.order.id);
});

test('GET /events/:id traz os setores com preço e estoque próprios', async () => {
  const res = await fetchJson('/events/match-1');
  assert.equal(res.status, 200);
  const codes = res.body.sectors.map((x) => x.code);
  assert.deepEqual(codes, ['norte', 'sul', 'central', 'camarote']);
  const camarote = res.body.sectors.find((x) => x.code === 'camarote');
  const norte = res.body.sectors.find((x) => x.code === 'norte');
  assert.ok(camarote.price > norte.price, 'camarote é mais caro que a arquibancada');
  assert.equal(res.body.price, Math.min(...res.body.sectors.map((x) => x.price)));
});

async function newEventWithStock(available = 40) {
  const res = await fetchJson('/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamHome: 'Res', teamAway: 'Erva', stadium: 'Arena Castelão', date: '2026-12-20T16:00:00', price: 30, available })
  });
  return res.body.event;
}
const sectorAvailable = async (eventId, code) =>
  (await fetchJson(`/events/${eventId}`)).body.sectors.find((x) => x.code === code).available;

test('Reserva temporária separa o estoque e a confirmação vira pedido', async () => {
  const ev = await newEventWithStock();
  const central = ev.sectors.find((x) => x.code === 'central');
  const token = await getUserToken();

  const anon = await fetchJson('/reservations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: ev.id, sectorId: central.id, quantity: 2 })
  });
  assert.equal(anon.status, 401);

  const resv = await fetchJson('/reservations', {
    method: 'POST', headers: authJson(token),
    body: JSON.stringify({ eventId: ev.id, sectorId: central.id, quantity: 2 })
  });
  assert.equal(resv.status, 201);
  assert.ok(resv.body.reservation.expiresAt);
  assert.equal(resv.body.reservation.total, central.price * 2);
  assert.equal(await sectorAvailable(ev.id, 'central'), central.available - 2, 'reservar tira do estoque');

  // Uma nova reserva do mesmo cliente libera a anterior
  const resv2 = await fetchJson('/reservations', {
    method: 'POST', headers: authJson(token),
    body: JSON.stringify({ eventId: ev.id, sectorId: central.id, quantity: 1 })
  });
  assert.equal(resv2.status, 201);
  assert.equal(await sectorAvailable(ev.id, 'central'), central.available - 1);

  // Outro cliente não confirma reserva alheia
  const intruder = (await fetchJson('/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Intruso', email: `intruso-${Date.now()}@email.com`, password: 'senha-segura' })
  })).body.token;
  const stolen = await fetchJson('/orders', {
    method: 'POST', headers: authJson(intruder), body: JSON.stringify({ reservationId: resv2.body.reservation.id })
  });
  assert.equal(stolen.status, 404);

  const old = await fetchJson('/orders', {
    method: 'POST', headers: authJson(token), body: JSON.stringify({ reservationId: resv.body.reservation.id })
  });
  assert.equal(old.status, 409, 'reserva substituída não pode mais ser usada');

  const buy = await fetchJson('/orders', {
    method: 'POST', headers: authJson(token), body: JSON.stringify({ reservationId: resv2.body.reservation.id })
  });
  assert.equal(buy.status, 201);
  assert.equal(buy.body.order.sectorName, 'Cadeira Central');
  assert.equal(buy.body.order.quantity, 1);
  assert.equal(await sectorAvailable(ev.id, 'central'), central.available - 1, 'confirmar não baixa o estoque de novo');

  const again = await fetchJson('/orders', {
    method: 'POST', headers: authJson(token), body: JSON.stringify({ reservationId: resv2.body.reservation.id })
  });
  assert.equal(again.status, 409, 'a mesma reserva não vira dois pedidos');
});

test('Reserva cancelada ou vencida devolve o estoque', async () => {
  const ev = await newEventWithStock();
  const sul = ev.sectors.find((x) => x.code === 'sul');
  const token = await getUserToken();

  const r1 = await fetchJson('/reservations', {
    method: 'POST', headers: authJson(token), body: JSON.stringify({ eventId: ev.id, sectorId: sul.id, quantity: 3 })
  });
  const del = await fetchJson(`/reservations/${r1.body.reservation.id}`, { method: 'DELETE', headers: authJson(token) });
  assert.equal(del.status, 200);
  assert.equal(await sectorAvailable(ev.id, 'sul'), sul.available, 'cancelar devolve o estoque');

  process.env.RESERVATION_TTL_SECONDS = '1';
  try {
    const r2 = await fetchJson('/reservations', {
      method: 'POST', headers: authJson(token), body: JSON.stringify({ eventId: ev.id, sectorId: sul.id, quantity: 4 })
    });
    assert.equal(r2.status, 201);
    const r3 = await fetchJson('/reservations', {
      method: 'POST', headers: authJson(await (async () => (await fetchJson('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Outro', email: `outro-${Date.now()}@email.com`, password: 'senha-segura' })
      })).body.token)()), body: JSON.stringify({ eventId: ev.id, sectorId: sul.id, quantity: 2 })
    });
    assert.equal(r3.status, 201);
    assert.equal(await sectorAvailable(ev.id, 'sul'), sul.available - 6);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    // Confirmar depois do prazo: recusado e o estoque volta na hora
    const late = await fetchJson('/orders', {
      method: 'POST', headers: authJson(token), body: JSON.stringify({ reservationId: r2.body.reservation.id })
    });
    assert.equal(late.status, 410);
    assert.equal(await sectorAvailable(ev.id, 'sul'), sul.available - 2);

    // A limpeza do worker devolve as demais reservas vencidas
    await worker.sweepReservations();
    assert.equal(await sectorAvailable(ev.id, 'sul'), sul.available, 'nenhum ingresso fica preso');
  } finally {
    delete process.env.RESERVATION_TTL_SECONDS;
  }
});

test('Compra publica PEDIDO_CONFIRMADO: o worker gera o PDF e envia o e-mail (fan-out)', async () => {
  const email = `pdf-${Date.now()}@email.com`;
  const reg = await fetchJson('/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Carla Torcedora', email, password: 'senha-segura' })
  });
  const token = reg.body.token;
  const ev = await newEventWithStock();
  const buy = await fetchJson('/orders', {
    method: 'POST', headers: authJson(token),
    body: JSON.stringify({ eventId: ev.id, sectorId: ev.sectors[0].id, quantity: 2 })
  });
  assert.equal(buy.status, 201);
  assert.equal(buy.body.notifications.published, true);
  const orderId = buy.body.order.id;

  const before = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(token) });
  assert.equal(before.status, 202, 'antes do worker o PDF ainda está sendo gerado');

  await worker.runOnce(); // consome as duas tarefas do fan-out (PDF e e-mail)

  const ready = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(token) });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  const pdf = await fetch(`${baseUrl}${ready.body.downloadUrl}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  // E-mail (em desenvolvimento vai para data/outbox) com o link de download
  const outbox = path.join(process.env.DATA_DIR, 'outbox');
  const mail = fs.readdirSync(outbox).map((f) => fs.readFileSync(path.join(outbox, f), 'utf8')).find((t) => t.includes(orderId));
  assert.ok(mail, 'e-mail de confirmação gerado');
  assert.ok(mail.startsWith(`Para: ${email}`));
  const link = mail.match(/https?:\/\/\S+\/tickets\/\S+/)[0];
  const viaEmail = await fetch(link.replace(/^https?:\/\/[^/]+/, baseUrl));
  assert.equal(viaEmail.status, 200, 'o link do e-mail baixa o ingresso sem login');

  // Segurança: token adulterado e pedido de outra pessoa
  const forged = await fetch(`${baseUrl}/tickets/${encodeURIComponent(orderId)}/download?token=abc`);
  assert.equal(forged.status, 401);
  const other = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(await getUserToken()) });
  assert.equal(other.status, 404);

  const logs = (await fetchJson('/audit-logs')).body.map((l) => l.action);
  assert.ok(logs.includes('TICKET_PDF_GENERATED') && logs.includes('EMAIL_SENT'));
});

test('Pedido antigo sem PDF: pedir o ingresso reenvia para a fila e o PDF é gerado', async () => {
  const token = await getUserToken();
  const ev = await newEventWithStock();
  const buy = await fetchJson('/orders', {
    method: 'POST', headers: authJson(token), body: JSON.stringify({ eventId: ev.id, quantity: 1 })
  });
  const orderId = buy.body.order.id;

  // Simula um pedido feito antes da geração de PDF: sem tarefas na fila e criado há 1 hora
  while (require('./src/lib/localStore').pullLocalTask()) { /* descarta o fan-out original */ }
  const storeFile = path.join(process.env.DATA_DIR, 'store.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  store.orders.find((o) => o.id === orderId).createdAt = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(storeFile, JSON.stringify(store));

  const first = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(token) });
  assert.equal(first.status, 202);
  const again = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(token) });
  assert.equal(again.status, 202, 'não reenfileira a cada clique');

  await worker.runOnce();
  const ready = await fetchJson(`/orders/${orderId}/ticket`, { headers: authJson(token) });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  const logs = (await fetchJson('/audit-logs')).body.filter((l) => String(l.payload).includes(orderId)).map((l) => l.action);
  assert.equal(logs.filter((a) => a === 'TICKET_PDF_REQUEUED').length, 1);
  assert.ok(!logs.includes('EMAIL_SENT'), 'regerar o PDF não reenvia o e-mail');
});

test('GET /users/me/email-notifications informa o estado da assinatura de e-mail', async () => {
  const token = await getUserToken();
  const res = await fetchJson('/users/me/email-notifications', { headers: authJson(token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'local', 'sem SNS configurado (testes) o e-mail é local');
  const anon = await fetchJson('/users/me/email-notifications');
  assert.equal(anon.status, 401);
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
