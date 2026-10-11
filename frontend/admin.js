// Painel administrativo: CRUD de jogos, pedidos, auditoria e infraestrutura
const API = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
const TOKEN_KEY = 'adm_token';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

let games = [];
let editingId = null;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------- API com token ---------- */
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Erro ${res.status}`);
  return body;
}

/* ---------- Login ---------- */
function showPanel(on) {
  $('login-view').classList.toggle('hidden', on);
  $('panel-view').classList.toggle('hidden', !on);
  $('logout').classList.toggle('hidden', !on);
}

async function login() {
  const err = $('login-error');
  err.classList.add('hidden');
  try {
    const res = await fetch(`${API}/auth/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('admin-password').value })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Falha no login.');
    sessionStorage.setItem(TOKEN_KEY, body.token);
    $('admin-password').value = '';
    showPanel(true);
    loadGames();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  stopStress();
  showPanel(false);
}

$('login-btn').addEventListener('click', login);
$('admin-password').addEventListener('keydown', (e) => e.key === 'Enter' && login());
$('logout').addEventListener('click', (e) => { e.preventDefault(); logout(); });

/* ---------- Abas ---------- */
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    ['games', 'orders', 'audit', 'infra'].forEach((n) => $(`tab-${n}`).classList.toggle('hidden', n !== tab.dataset.tab));
    if (tab.dataset.tab === 'games') loadGames();
    if (tab.dataset.tab === 'orders') loadOrders();
    if (tab.dataset.tab === 'audit') loadAudit();
    if (tab.dataset.tab === 'infra') loadHealth();
  })
);

/* ---------- Jogos (CRUD) ---------- */
async function loadGames() {
  try {
    games = await api('/events');
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    $('games-body').innerHTML = games.length
      ? games.map((g) => `<tr>
          <td><b>${esc(g.teamHome)} x ${esc(g.teamAway)}</b><br><small style="color:var(--muted)">${esc(g.id)}</small></td>
          <td>${esc(g.stadium)}</td>
          <td>${esc(fmt(g.date))}</td>
          <td>${esc(g.category)}</td>
          <td>${money(g.price)}</td>
          <td>${esc(g.available)}</td>
          <td><span class="badge ${g.processingStatus === 'completed' ? 'ok' : ''}">${esc(g.processingStatus || '—')}</span></td>
          <td class="actions-cell">
            <button class="btn btn-ghost btn-sm" data-edit="${esc(g.id)}">Editar</button>
            <button class="btn btn-danger btn-sm" data-del="${esc(g.id)}">Excluir</button>
          </td></tr>`).join('')
      : `<tr><td colspan="8" class="empty">Nenhum jogo cadastrado.</td></tr>`;
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.edit)));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeGame(b.dataset.del)));
  } catch (e) { toast(e.message); }
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openForm(id) {
  editingId = id || null;
  const g = games.find((x) => x.id === id);
  $('dialog-title').textContent = g ? 'Editar jogo' : 'Novo jogo';
  $('f-home').value = g?.teamHome || '';
  $('f-away').value = g?.teamAway || '';
  const sel = $('f-stadium');
  // mantém estádios fora do padrão (dados antigos) selecionáveis ao editar
  [...sel.querySelectorAll('[data-extra]')].forEach((o) => o.remove());
  if (g && ![...sel.options].some((o) => o.value === g.stadium)) {
    sel.insertAdjacentHTML('beforeend', `<option data-extra value="${esc(g.stadium)}">${esc(g.stadium)}</option>`);
  }
  sel.value = g?.stadium || 'Arena Castelão';
  $('f-date').value = g ? toLocalInput(g.date) : '';
  $('f-price').value = g?.price ?? '';
  $('f-available').value = g?.available ?? '';
  $('f-category').value = g?.category || 'Arquibancada';
  $('f-description').value = g?.description || '';
  $('f-banner').value = '';
  $('form-error').classList.add('hidden');
  $('game-dialog').showModal();
}

$('new-game').addEventListener('click', () => openForm(null));
$('cancel-dialog').addEventListener('click', () => $('game-dialog').close());

$('game-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('save-game');
  const err = $('form-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  try {
    const fd = new FormData();
    fd.append('teamHome', $('f-home').value.trim());
    fd.append('teamAway', $('f-away').value.trim());
    fd.append('stadium', $('f-stadium').value);
    fd.append('date', new Date($('f-date').value).toISOString());
    fd.append('price', $('f-price').value);
    fd.append('available', $('f-available').value);
    fd.append('category', $('f-category').value.trim() || 'Arquibancada');
    fd.append('description', $('f-description').value.trim());
    const file = $('f-banner').files[0];
    if (file) fd.append('banner', file);

    const body = await api(editingId ? `/events/${encodeURIComponent(editingId)}` : '/events', {
      method: editingId ? 'PUT' : 'POST',
      body: fd
    });
    $('game-dialog').close();
    toast(body.message || 'Salvo!');
    loadGames();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
});

async function removeGame(id) {
  const g = games.find((x) => x.id === id);
  if (!confirm(`Excluir o jogo ${g ? `${g.teamHome} x ${g.teamAway}` : id}?`)) return;
  try {
    const body = await api(`/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(body.message || 'Removido.');
    loadGames();
  } catch (e) { toast(e.message); }
}

/* ---------- Pedidos ---------- */
async function loadOrders() {
  try {
    const orders = await api('/orders');
    $('orders-body').innerHTML = orders.length
      ? orders.map((o) => `<tr>
          <td>${esc(o.id)}</td>
          <td>${esc(o.event_name ?? o.eventName)}</td>
          <td>${esc(o.customer_name ?? o.customerName)}</td>
          <td>${esc(o.customer_email ?? o.customerEmail)}</td>
          <td>${esc(o.quantity)}</td>
          <td>${money(o.total)}</td>
          <td>${esc(fmt(o.created_at ?? o.createdAt))}</td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">Nenhum pedido ainda.</td></tr>`;
  } catch (e) { toast(e.message); }
}
$('refresh-orders').addEventListener('click', loadOrders);

/* ---------- Auditoria ---------- */
async function loadAudit() {
  try {
    const logs = await api('/audit-logs');
    logs.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    $('audit-body').innerHTML = logs.length
      ? logs.map((l) => {
          let pretty = l.payload;
          try { pretty = JSON.stringify(JSON.parse(l.payload), null, 2); } catch (_) { /* mantém texto */ }
          return `<tr>
            <td>${esc(fmt(l.timestamp))}</td>
            <td><span class="badge ${esc(l.action)}">${esc(l.action)}</span></td>
            <td>${esc(l.resource)}</td>
            <td><details><summary>ver dados</summary><pre class="json">${esc(pretty)}</pre></details></td></tr>`;
        }).join('')
      : `<tr><td colspan="4" class="empty">Sem registros.</td></tr>`;
  } catch (e) { toast(e.message); }
}
$('refresh-audit').addEventListener('click', loadAudit);

/* ---------- Infraestrutura ---------- */
const hostsSeen = new Map();
function seeHost(name) {
  if (!name) return;
  hostsSeen.set(name, (hostsSeen.get(name) || 0) + 1);
  $('st-hosts').textContent = hostsSeen.size;
  $('host-list').innerHTML = [...hostsSeen.entries()]
    .map(([h, n]) => `<li><span>${esc(h)}</span><span>${n} resp.</span></li>`).join('');
}

async function loadHealth() {
  try {
    const res = await fetch(`${API}/health`);
    const h = await res.json();
    seeHost(h.instance?.hostname);
    const svc = h.awsServices || {};
    const cards = [
      ['💻', 'EC2 + ALB + ASG', true, h.instance?.hostname || 'ativo'],
      ['🐘', 'RDS PostgreSQL', svc.rds],
      ['⚡', 'ElastiCache Redis', svc.elasticache],
      ['🪣', 'S3 (banners)', svc.s3],
      ['📝', 'DynamoDB (auditoria)', svc.dynamodb],
      ['📬', 'SQS / SNS', svc.sqsSns]
    ];
    $('aws-grid').innerHTML = cards.map(([ico, name, ok, extra]) => `<div class="aws-card">
      <div class="ico">${ico}</div><h4>${esc(name)}</h4>
      <span class="badge ${ok ? 'ok' : 'off'}">${ok ? (extra || 'configurado') : 'não configurado'}</span></div>`).join('');
  } catch (e) { toast('Falha ao consultar /health'); }
}
$('refresh-health').addEventListener('click', loadHealth);

/* ---------- Teste de carga ---------- */
let stress = null;

function startStress() {
  if (stress) return;
  const conc = Math.max(1, Math.min(30, Number($('stress-conc').value) || 8));
  const secs = Math.max(10, Math.min(1800, Number($('stress-secs').value) || 300));
  const s = { stop: false, done: 0, err: 0, t0: Date.now(), secs };
  stress = s;
  $('stress-start').disabled = true;
  $('stress-stop').disabled = false;
  $('st-done').textContent = '0';
  $('st-err').textContent = '0';

  const worker = async () => {
    while (!s.stop && (Date.now() - s.t0) / 1000 < secs) {
      try {
        const res = await fetch(`${API}/stress?duration=4000`);
        const body = await res.json();
        if (!res.ok) throw new Error('http');
        s.done++;
        seeHost(body.instance);
      } catch (_) {
        s.err++;
        await new Promise((r) => setTimeout(r, 500));
      }
      $('st-done').textContent = s.done;
      $('st-err').textContent = s.err;
    }
  };
  s.workers = Promise.all(Array.from({ length: conc }, worker)).then(() => { if (stress === s) stopStress(); });
  s.timer = setInterval(() => {
    $('st-elapsed').textContent = `${Math.round((Date.now() - s.t0) / 1000)}s`;
  }, 500);
  s.health = setInterval(loadHealth, 4000);
}

function stopStress() {
  if (!stress) return;
  stress.stop = true;
  clearInterval(stress.timer);
  clearInterval(stress.health);
  stress = null;
  $('stress-start').disabled = false;
  $('stress-stop').disabled = true;
}

$('stress-start').addEventListener('click', startStress);
$('stress-stop').addEventListener('click', stopStress);

/* ---------- Início ---------- */
if (sessionStorage.getItem(TOKEN_KEY)) {
  showPanel(true);
  loadGames();
}
