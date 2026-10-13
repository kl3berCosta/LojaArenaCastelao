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
    if (tab.dataset.tab === 'infra') {
      loadHealth();
      startElasticityPolling();
    }
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
  $('f-price').value = '';
  $('f-available').value = '';
  // Criação: preço base + capacidade (setores automáticos). Edição: preço e estoque de cada setor.
  $('create-stock').classList.toggle('hidden', !!g);
  $('create-stock-hint').classList.toggle('hidden', !!g);
  $('edit-sectors').classList.toggle('hidden', !g);
  $('f-price').required = !g;
  $('f-available').required = !g;
  $('f-sectors').innerHTML = '';
  if (g) {
    api(`/events/${encodeURIComponent(g.id)}`).then((full) => {
      $('f-sectors').innerHTML = (full.sectors || []).map((s) => `<tr data-sector-id="${esc(s.id)}">
        <td>${esc(s.name)}</td>
        <td><input type="number" min="0.01" step="0.01" value="${esc(s.price)}" data-field="price" /></td>
        <td><input type="number" min="0" step="1" value="${esc(s.available)}" data-field="available" /></td></tr>`).join('');
    }).catch((e) => toast(e.message));
  }
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
    if (editingId) {
      const sectors = [...document.querySelectorAll('#f-sectors tr')].map((tr) => ({
        id: tr.dataset.sectorId,
        price: tr.querySelector('[data-field="price"]').value,
        available: tr.querySelector('[data-field="available"]').value
      }));
      if (sectors.length) fd.append('sectors', JSON.stringify(sectors));
    } else {
      fd.append('price', $('f-price').value);
      fd.append('available', $('f-available').value);
    }
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
      ['📬', 'SQS / SNS (banners)', svc.sqsSns],
      ['🔀', 'SNS fan-out (PDF + e-mail)', svc.orderFanout],
      ['✉️', 'E-mail via SNS', svc.emailSns],
      ['📈', 'CloudWatch (métricas)', svc.cloudwatchMetrics]
    ];
    $('aws-grid').innerHTML = cards.map(([ico, name, ok, extra]) => `<div class="aws-card">
      <div class="ico">${ico}</div><h4>${esc(name)}</h4>
      <span class="badge ${ok ? 'ok' : 'off'}">${ok ? (extra || 'configurado') : 'não configurado'}</span></div>`).join('');
  } catch (e) { toast('Falha ao consultar /health'); }
}
$('refresh-health').addEventListener('click', loadHealth);

/* ---------- Teste de elasticidade: carga pelo navegador ---------- */
let stress = null;
const fmtClock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

function startStress() {
  if (stress) return;
  const conc = Math.max(1, Math.min(12, Number($('stress-conc').value) || 6));
  const secs = Math.max(60, Math.min(1800, (Number($('stress-mins').value) || 8) * 60));
  const s = { stop: false, done: 0, err: 0, t0: Date.now(), secs };
  stress = s;
  hostsSeen.clear();
  $('host-list').innerHTML = '<li><span>—</span><span>aguardando respostas</span></li>';
  $('stress-start').disabled = true;
  $('stress-stop').disabled = false;
  $('st-done').textContent = '0';
  $('st-err').textContent = '0';

  // Cada "trabalhador" mantém uma requisição de 4 s em andamento até o fim do teste
  const loop = async () => {
    while (!s.stop && (Date.now() - s.t0) / 1000 < secs) {
      try {
        const body = await api('/stress?duration=4000');
        s.done++;
        seeHost(body.instance);
      } catch (_) {
        s.err++;
        await new Promise((r) => setTimeout(r, 1000)); // instância sendo trocada: espera um pouco
      }
      $('st-done').textContent = s.done;
      $('st-err').textContent = s.err;
    }
  };
  s.workers = Promise.all(Array.from({ length: conc }, loop)).then(() => { if (stress === s) stopStress(); });
  s.timer = setInterval(() => {
    $('st-elapsed').textContent = fmtClock(Math.round((Date.now() - s.t0) / 1000));
  }, 500);
  // Também consulta o /health (que não passa pela fila de /stress) para ver novas instâncias logo que entram
  s.health = setInterval(async () => {
    try {
      const h = await (await fetch(`${API}/health`, { cache: 'no-store' })).json();
      seeHost(h.instance?.hostname);
    } catch (_) { /* ignora */ }
  }, 3000);
  startElasticityPolling();
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

/* ---------- Auto Scaling ao vivo (dados da AWS via /admin/elasticity) ---------- */
let elasticityTimer = null;

function startElasticityPolling() {
  if (elasticityTimer) return;
  loadElasticity();
  elasticityTimer = setInterval(loadElasticity, 5000);
}

const ptTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function describeActivity(a) {
  const id = (a.description.match(/i-[0-9a-f]+/) || [''])[0];
  const byAlarm = /alarm/i.test(a.cause || '');
  if (/^Launching/i.test(a.description)) return { icon: '🟢', text: `Nova instância criada ${id}`, why: byAlarm ? 'scale-out (CPU > 70%)' : 'reposição / capacidade desejada' };
  if (/^Terminating/i.test(a.description)) return { icon: '🔴', text: `Instância encerrada ${id}`, why: byAlarm ? 'scale-in (CPU < 25%)' : 'substituição / manual' };
  return { icon: '•', text: a.description, why: '' };
}

const ACTIVITY_STATUS = {
  Successful: 'concluída', InProgress: 'em andamento', Failed: 'falhou', Cancelled: 'cancelada',
  WaitingForELBConnectionDraining: 'drenando conexões', PreInService: 'iniciando', WaitingForSpotInstanceId: 'aguardando',
  MidLifecycleAction: 'em andamento', WaitingForInstanceWarmup: 'aquecendo'
};

const LIFECYCLE = {
  InService: 'em serviço', Pending: 'iniciando', 'Pending:Wait': 'iniciando', 'Pending:Proceed': 'iniciando',
  Terminating: 'encerrando', 'Terminating:Wait': 'encerrando', Terminated: 'encerrada'
};

function chartSvg(cpu, inst) {
  const W = 520; const H = 170; const L = 30; const R = 26; const T = 10; const B = 22;
  const all = [...cpu, ...inst].map((p) => new Date(p.t).getTime());
  if (!all.length) return '<div class="empty" style="padding:30px">Sem dados de CPU ainda (as métricas chegam a cada minuto).</div>';
  const t0 = Math.min(...all); const t1 = Math.max(...all, t0 + 60000);
  const x = (t) => L + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const yCpu = (v) => T + (1 - v / 100) * (H - T - B);
  const yInst = (v) => T + (1 - v / 4) * (H - T - B);
  const cpuPath = cpu.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${yCpu(p.v).toFixed(1)}`).join(' ');
  const instPath = inst.map((p, i) => {
    const px = x(p.t).toFixed(1); const py = yInst(p.v).toFixed(1);
    return i ? `H${px} V${py}` : `M${px},${py}`;
  }).join(' ');
  const ticks = [0, 25, 50, 70, 100].map((v) => `<text x="${L - 4}" y="${yCpu(v) + 3}" class="ax" text-anchor="end">${v}</text>`).join('');
  const instTicks = [1, 2, 3].map((v) => `<text x="${W - R + 4}" y="${yInst(v) + 3}" class="ax inst">${v}</text>`).join('');
  const times = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${x(t)}" y="${H - 6}" class="ax" text-anchor="${['start', 'middle', 'end'][i]}">${new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" class="plot" />
    <line x1="${L}" x2="${W - R}" y1="${yCpu(70)}" y2="${yCpu(70)}" class="lim hi" />
    <line x1="${L}" x2="${W - R}" y1="${yCpu(25)}" y2="${yCpu(25)}" class="lim lo" />
    ${ticks}${instTicks}${times}
    <path d="${instPath}" class="inst-line" />
    <path d="${cpuPath}" class="cpu-line" />
  </svg>`;
}

async function loadElasticity() {
  try {
    const d = await api('/admin/elasticity');
    if (!d.available) {
      $('as-live').classList.add('hidden');
      $('as-unavailable').textContent = d.reason || 'Indisponível fora da AWS.';
      $('as-unavailable').classList.remove('hidden');
      return;
    }
    $('as-unavailable').classList.add('hidden');
    $('as-live').classList.remove('hidden');
    const g = d.group;
    $('as-inservice').textContent = g.inService;
    $('as-desired').textContent = g.desired;
    $('as-max').textContent = g.max;
    const last = d.cpu[d.cpu.length - 1];
    $('as-cpu').textContent = last ? `${Math.round(last.v)}%` : '–';

    $('as-alarms').innerHTML = d.alarms.map((a) => {
      const high = /high/.test(a.name);
      const label = high ? 'CPU > 70% (scale-out)' : 'CPU < 25% (scale-in)';
      return `<span class="as-alarm ${a.state === 'ALARM' ? (high ? 'fire' : 'calm') : ''}">${esc(label)}: <b>${esc(a.state)}</b></span>`;
    }).join('');

    $('as-chart').innerHTML = chartSvg(d.cpu, d.inServiceHistory);

    $('as-instances').innerHTML = g.instances.length
      ? g.instances.map((i) => `<li><span>${esc(i.id)} · ${esc(i.zone)}</span><span class="lc ${esc(i.state.split(':')[0])}">${esc(LIFECYCLE[i.state] || i.state)} · ${esc(i.health === 'Healthy' ? 'saudável' : 'não saudável')}</span></li>`).join('')
      : '<li><span>—</span><span>nenhuma</span></li>';

    $('as-activities').innerHTML = d.activities.map((a) => {
      const x = describeActivity(a);
      return `<li><span class="when">${esc(ptTime(a.time))}</span><span>${x.icon} ${esc(x.text)}${x.why ? ` <small>(${esc(x.why)})</small>` : ''}</span><span class="st">${esc(ACTIVITY_STATUS[a.status] || a.status)}</span></li>`;
    }).join('') || '<li><span>—</span><span>sem atividades</span></li>';

    $('as-updated').textContent = `atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch (e) {
    $('as-updated').textContent = `falha ao consultar: ${e.message}`;
  }
}

/* ---------- Início ---------- */
if (sessionStorage.getItem(TOKEN_KEY)) {
  showPanel(true);
  loadGames();
}
