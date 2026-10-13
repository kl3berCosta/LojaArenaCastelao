// Loja de Ingressos - Fluxo com autenticação e validação de login na compra
const API = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
const MAX_PER_ORDER = 6;
const USER_KEY = 'ticket_user';
const TOKEN_KEY = 'ticket_token';

const STADIUMS = {
  castelao: {
    key: 'castelao',
    name: 'Arena Castelão',
    city: 'Fortaleza, CE',
    test: /castel/i
  },
  vargas: {
    key: 'vargas',
    name: 'Estádio Presidente Vargas',
    city: 'Fortaleza, CE',
    test: /vargas/i
  }
};

const state = {
  events: [],
  event: null,
  quantity: 1,
  order: null,
  sector: null, // setor escolhido no mapa
  reservation: null, // reserva temporária ativa (checkout)
  user: null,
  filter: 'all'
};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function loadSavedUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) state.user = JSON.parse(raw);
  } catch (e) {
    state.user = null;
  }
}

function saveUser(user, token) {
  state.user = user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (token) localStorage.setItem(TOKEN_KEY, token);
  renderUserNav();
  if (state.event) {
    renderStep2();
  }
}

function logoutUser() {
  state.user = null;
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
  renderUserNav();
  if (!document.getElementById('step-2').classList.contains('hidden')) {
    renderStep2();
  } else if (!document.getElementById('step-3').classList.contains('hidden')) {
    // Sem login a reserva não pode ser confirmada; ela expira sozinha e o estoque volta
    stopTimer();
    state.reservation = null;
    showStep(2);
    renderStep2();
  }
}

function stadiumKeyOf(ev) {
  const s = norm(ev.stadium);
  return Object.values(STADIUMS).find((st) => st.test.test(s))?.key || 'outro';
}

function formatGameDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  } catch (e) {
    return iso;
  }
}

function formatGameTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function upcoming(events) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return events
    .filter((e) => new Date(e.date) >= today)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function loadEvents() {
  const res = await fetch(`${API}/events`);
  if (!res.ok) throw new Error('Não foi possível carregar os jogos.');
  state.events = upcoming(await res.json());
}

/* ---------- Navegação entre etapas (1 a 4) ---------- */
function showStep(n) {
  document.querySelectorAll('.step').forEach((el) => el.classList.add('hidden'));
  const targetStep = $(`step-${n}`);
  if (targetStep) targetStep.classList.remove('hidden');

  document.querySelectorAll('#stepper li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
    li.querySelector('.dot').textContent = s < n ? '✓' : s;
  });

  const comprarSection = $('comprar');
  if (comprarSection) {
    comprarSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

document.querySelectorAll('[data-back]').forEach((btn) =>
  btn.addEventListener('click', () => showStep(Number(btn.dataset.back)))
);

/* ---------- Badges de estoque ---------- */
function stockBadge(ev) {
  if (ev.available <= 0) return '<span class="stock out">Esgotado</span>';
  if (ev.available < 30) return `<span class="stock low">Últimos ${ev.available}</span>`;
  return `<span class="stock ok">${ev.available} disponíveis</span>`;
}

/* ---------- Renderização do Topbar com usuário ---------- */
function renderUserNav() {
  const container = $('user-nav');
  if (!container) return;

  if (state.user) {
    container.innerHTML = `
      <a href="/meus-ingressos.html" class="nav-tickets-link">🎟️ Meus ingressos</a>
      <div class="user-session">
        <span class="user-pill">👤 <strong>${esc(state.user.name)}</strong></span>
        <button type="button" class="btn-logout" id="btn-logout" title="Sair da conta">Sair</button>
      </div>
    `;
    $('btn-logout').addEventListener('click', logoutUser);
  } else {
    container.innerHTML = `
      <button type="button" class="btn-auth-trigger" id="btn-open-login">
        👤 Entrar / Cadastrar
      </button>
    `;
    $('btn-open-login').addEventListener('click', () => openAuthModal());
  }
}

/* ---------- Modal de Autenticação ---------- */
function openAuthModal(onSuccessCallback) {
  const modal = $('auth-modal');
  modal.classList.remove('hidden');
  $('login-error').classList.add('hidden');
  $('register-error').classList.add('hidden');
  switchAuthTab('login');
  modal._onSuccess = onSuccessCallback;
}

function closeAuthModal() {
  const modal = $('auth-modal');
  modal.classList.add('hidden');
  modal._onSuccess = null;
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  $('tab-login-btn').classList.toggle('active', isLogin);
  $('tab-register-btn').classList.toggle('active', !isLogin);
  $('form-login').classList.toggle('hidden', !isLogin);
  $('form-register').classList.toggle('hidden', isLogin);
  $('login-error').classList.add('hidden');
  $('register-error').classList.add('hidden');
}

$('auth-close-btn').addEventListener('click', closeAuthModal);
$('tab-login-btn').addEventListener('click', () => switchAuthTab('login'));
$('tab-register-btn').addEventListener('click', () => switchAuthTab('register'));

// Fechar modal ao clicar fora
$('auth-modal').addEventListener('click', (e) => {
  if (e.target === $('auth-modal')) closeAuthModal();
});

// Submit Login
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const btn = $('btn-submit-login');
  const err = $('login-error');

  btn.disabled = true;
  btn.textContent = 'Verificando...';
  err.classList.add('hidden');

  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Falha ao autenticar.');

    saveUser(body.user, body.token);
    const cb = $('auth-modal')._onSuccess;
    closeAuthModal();

    if (cb) {
      cb();
    } else if (state.event && !$('step-2').classList.contains('hidden')) {
      renderStep2();
    }
  } catch (error) {
    err.textContent = error.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar e Continuar →';
  }
});

// Submit Cadastro
$('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('reg-name').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  const btn = $('btn-submit-reg');
  const err = $('register-error');

  btn.disabled = true;
  btn.textContent = 'Criando conta...';
  err.classList.add('hidden');

  try {
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Falha ao cadastrar.');

    saveUser(body.user, body.token);
    const cb = $('auth-modal')._onSuccess;
    closeAuthModal();

    if (cb) {
      cb();
    } else if (state.event && !$('step-2').classList.contains('hidden')) {
      renderStep2();
    }
  } catch (error) {
    err.textContent = error.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Cadastrar e Continuar →';
  }
});

/* ---------- Renderização dos Jogos no Menu Principal ---------- */
function renderGames() {
  let list = state.events;
  if (state.filter !== 'all') {
    list = list.filter((e) => stadiumKeyOf(e) === state.filter);
  }

  const container = $('game-list');
  if (!list.length) {
    container.innerHTML = `<div class="empty" style="grid-column:1/-1">Nenhum jogo encontrado para os critérios selecionados.</div>`;
    return;
  }

  container.innerHTML = list.map((ev) => {
    const img = ev.thumbnailUrl || ev.bannerUrl;
    const stadiumName = ev.stadium || 'Estádio';
    const dateFormatted = formatGameDate(ev.date);
    const timeFormatted = formatGameTime(ev.date);

    return `
      <article class="game-card">
        <div class="game-banner">
          ${img ? `<img src="${esc(img)}" alt="${esc(ev.teamHome)} x ${esc(ev.teamAway)}" onerror="this.remove()" />` : ''}
          <div class="vs">
            <span class="team-name">${esc(ev.teamHome)}</span>
            <span class="vs-symbol">×</span>
            <span class="team-name">${esc(ev.teamAway)}</span>
          </div>
        </div>
        <div class="game-body">
          <h3 class="game-title">${esc(ev.teamHome)} <span style="opacity:.6">×</span> ${esc(ev.teamAway)}</h3>
          
          <!-- Informação do estádio abaixo do confronto -->
          <div class="game-meta stadium-info">
            <span class="meta-icon">🏟️</span>
            <span class="stadium-name">${esc(stadiumName)}</span>
          </div>

          <!-- Horário e Data do jogo -->
          <div class="game-datetime-row">
            <div class="datetime-item date-pill">
              <span class="meta-icon">📅</span>
              <span>${esc(dateFormatted)}</span>
            </div>
            <div class="datetime-item time-pill">
              <span class="meta-icon">⏰</span>
              <strong>${esc(timeFormatted)}</strong>
            </div>
          </div>

          <!-- Categoria e Descrição -->
          <div class="game-meta category-info">
            <span class="meta-icon">🎟️</span>
            <span>${esc(ev.category)}${ev.description ? ' · ' + esc(ev.description) : ''}</span>
          </div>

          <div class="game-foot">
            <div class="price">
              <small>a partir de</small>
              ${money(ev.price)}
            </div>
            ${stockBadge(ev)}
          </div>

          <button class="btn btn-primary btn-select-game" data-event="${esc(ev.id)}" ${ev.available <= 0 ? 'disabled' : ''}>
            ${ev.available <= 0 ? 'Esgotado' : 'Comprar Ingresso →'}
          </button>
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('[data-event]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const selected = state.events.find((e) => e.id === btn.dataset.event);
      if (!selected) return;
      openEvent(selected.id);
    })
  );
}

/* ---------- Filtros de Estádio ---------- */
document.querySelectorAll('#stadium-filters .filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#stadium-filters .filter-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.filter = chip.dataset.filter;
    renderGames();
  });
});

/* ---------- Chamadas autenticadas ---------- */
function authHeaders(json = true) {
  const h = { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// Sessão expirada: limpa o login e pede para entrar de novo
function handleExpiredSession(after) {
  logoutUser();
  openAuthModal(after);
  throw new Error('Sua sessão expirou. Entre novamente para continuar.');
}

async function loadEventDetail(id) {
  const res = await fetch(`${API}/events/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Não foi possível carregar os setores deste jogo.');
  return res.json();
}

/* ---------- Resumo do Pedido ---------- */
function summaryHtml(withBuyer) {
  const ev = state.event;
  if (!ev) return '';
  const sector = state.sector;
  const rows = [
    ['Jogo', `${ev.teamHome} x ${ev.teamAway}`],
    ['Estádio', ev.stadium || 'Estádio'],
    ['Data', formatGameDate(ev.date)],
    ['Horário', formatGameTime(ev.date)],
    ['Setor', sector ? sector.name : 'Escolha no mapa'],
    ['Preço unitário', sector ? money(sector.price) : '—'],
    ['Quantidade', state.quantity]
  ];
  if (withBuyer && state.user) {
    rows.push(['Titular', state.user.name], ['E-mail', state.user.email]);
  }
  return `
    <h3>Resumo do Pedido</h3>
    ${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
    <div class="row total"><span>Total</span><span>${sector ? money(sector.price * state.quantity) : '—'}</span></div>
  `;
}

/* ---------- Etapa 2: mapa do estádio, setor e quantidade ---------- */
// Posição de cada setor no desenho do estádio (viewBox 400 x 260)
const MAP_LAYOUT = {
  norte: { x: 92, y: 12, w: 216, h: 48, label: 'Norte' },
  sul: { x: 92, y: 200, w: 216, h: 48, label: 'Sul' },
  central: { x: 18, y: 66, w: 80, h: 128, label: 'Central' },
  camarote: { x: 302, y: 92, w: 80, h: 76, label: 'Camarote' }
};

function sectorClass(s) {
  if (s.available <= 0) return 'soldout';
  return state.sector?.id === s.id ? 'selected' : '';
}

function renderStadiumMap() {
  const sectors = state.event.sectors || [];
  const shapes = sectors.map((s) => {
    const l = MAP_LAYOUT[s.code];
    if (!l) return '';
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    const status = s.available <= 0 ? 'Esgotado' : money(s.price);
    return `
      <g class="map-sector ${sectorClass(s)}" data-sector="${esc(s.id)}" tabindex="${s.available > 0 ? 0 : -1}"
         role="button" aria-label="${esc(s.name)}: ${esc(status)}">
        <rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="10" />
        <text x="${cx}" y="${cy - 3}" class="map-name">${esc(l.label)}</text>
        <text x="${cx}" y="${cy + 13}" class="map-price">${esc(status)}</text>
      </g>`;
  }).join('');

  $('stadium-map').innerHTML = `
    <svg viewBox="0 0 400 260" xmlns="http://www.w3.org/2000/svg">
      <rect x="110" y="70" width="180" height="120" rx="6" class="map-field" />
      <line x1="200" y1="70" x2="200" y2="190" class="map-line" />
      <circle cx="200" cy="130" r="20" class="map-line" />
      <rect x="110" y="104" width="22" height="52" class="map-line" />
      <rect x="268" y="104" width="22" height="52" class="map-line" />
      ${shapes}
    </svg>`;

  $('sector-list').innerHTML = sectors.map((s) => `
    <button type="button" class="sector-card ${sectorClass(s)}" data-sector="${esc(s.id)}" role="radio"
            aria-checked="${state.sector?.id === s.id}" ${s.available <= 0 ? 'disabled' : ''}>
      <span class="sector-name">${esc(s.name)}</span>
      <span class="sector-price">${money(s.price)}</span>
      <span class="sector-stock">${s.available <= 0 ? 'Esgotado' : s.available < 20 ? `Últimos ${s.available}` : `${s.available} lugares`}</span>
    </button>`).join('');

  document.querySelectorAll('[data-sector]').forEach((el) => {
    const pick = () => selectSector(el.dataset.sector);
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
  });
}

function selectSector(id) {
  const s = (state.event.sectors || []).find((x) => x.id === id);
  if (!s || s.available <= 0) return;
  state.sector = s;
  state.quantity = Math.min(state.quantity, maxQty()) || 1;
  renderStep2();
}

const maxQty = () => (state.sector ? Math.min(MAX_PER_ORDER, state.sector.available) : MAX_PER_ORDER);

function renderStep2() {
  const ev = state.event;
  if (!ev) return;
  // Mantém o setor escolhido atualizado (estoque pode ter mudado)
  if (state.sector) state.sector = (ev.sectors || []).find((s) => s.id === state.sector.id && s.available > 0) || null;
  state.quantity = Math.max(1, Math.min(state.quantity, maxQty()));

  $('selected-game-preview').innerHTML = `
    <div class="preview-content">
      <span class="preview-tag">Jogo Selecionado</span>
      <h3>${esc(ev.teamHome)} × ${esc(ev.teamAway)}</h3>
      <p>🏟️ <strong>${esc(ev.stadium)}</strong> · 📅 ${esc(formatGameDate(ev.date))} às ⏰ <strong>${esc(formatGameTime(ev.date))}</strong></p>
    </div>`;

  renderStadiumMap();
  $('qty-value').textContent = state.quantity;
  $('qty-hint').textContent = state.sector
    ? `Máximo de ${maxQty()} ingresso(s) por compra neste setor.`
    : 'Escolha um setor para ver os lugares disponíveis.';
  $('summary-2').innerHTML = summaryHtml(false);
  $('to-review').disabled = !state.sector;

  const authInd = $('step2-auth-indicator');
  if (state.user) {
    authInd.innerHTML = `
      <div class="auth-box-status logged">
        <span class="auth-icon-check">✓</span>
        <div>
          <strong>Identificado como:</strong> ${esc(state.user.name)} (${esc(state.user.email)})
          <button type="button" class="btn-link" id="btn-step2-logout">Trocar de conta</button>
        </div>
      </div>`;
    $('btn-step2-logout').addEventListener('click', logoutUser);
  } else {
    authInd.innerHTML = `
      <div class="auth-box-status not-logged">
        <span class="auth-icon-lock">🔒</span>
        <div>Para reservar, pediremos seu login ou cadastro. Os ingressos ficam vinculados à sua conta.</div>
      </div>`;
  }
}

async function openEvent(id) {
  $('step2-error').classList.add('hidden');
  try {
    state.event = await loadEventDetail(id);
    state.sector = null;
    state.quantity = 1;
    renderStep2();
    showStep(2);
  } catch (e) {
    alert(e.message);
  }
}

function changeQty(delta) {
  if (!state.event) return;
  state.quantity = Math.max(1, Math.min(maxQty(), state.quantity + delta));
  $('qty-value').textContent = state.quantity;
  $('summary-2').innerHTML = summaryHtml(false);
}

$('qty-minus').addEventListener('click', () => changeQty(-1));
$('qty-plus').addEventListener('click', () => changeQty(1));

/* ---------- Reserva temporária (Etapa 2 -> 3) ---------- */
let timerHandle = null;

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function renderTimer() {
  const r = state.reservation;
  const box = $('reservation-timer');
  if (!r) {
    box.innerHTML = '';
    return;
  }
  const left = Math.max(0, Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  box.className = `reservation-timer${left <= 60 ? ' urgent' : ''}${left === 0 ? ' expired' : ''}`;
  box.innerHTML = left > 0
    ? `⏳ Ingressos reservados por <strong>${mm}:${ss}</strong> · ${esc(r.quantity)} × ${esc(r.sectorName || state.sector?.name || '')}`
    : '⌛ O tempo da reserva acabou e os ingressos voltaram para a venda.';
  if (left === 0) {
    stopTimer();
    $('confirm-order').disabled = true;
  }
}

function startTimer() {
  stopTimer();
  $('confirm-order').disabled = false;
  renderTimer();
  timerHandle = setInterval(renderTimer, 1000);
}

async function startCheckout() {
  const err = $('step2-error');
  err.classList.add('hidden');
  if (!state.sector) return;
  const btn = $('to-review');
  btn.disabled = true;
  btn.textContent = 'Reservando...';
  try {
    const res = await fetch(`${API}/reservations`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ eventId: state.event.id, sectorId: state.sector.id, quantity: state.quantity })
    });
    if (res.status === 401) handleExpiredSession(() => startCheckout());
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Não foi possível reservar os ingressos.');

    state.reservation = body.reservation;
    renderStep3();
    showStep(3);
    startTimer();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
    // Estoque pode ter mudado: atualiza o mapa
    loadEventDetail(state.event.id).then((ev) => { state.event = ev; renderStep2(); }).catch(() => {});
  } finally {
    btn.disabled = !state.sector;
    btn.textContent = 'Reservar e continuar →';
  }
}

$('to-review').addEventListener('click', () => {
  if (!state.user) {
    openAuthModal(() => startCheckout());
    return;
  }
  startCheckout();
});

// Desistiu na revisão: cancela a reserva (o estoque volta na hora) e volta ao mapa
async function cancelReservation() {
  const r = state.reservation;
  state.reservation = null;
  stopTimer();
  if (!r) return;
  await fetch(`${API}/reservations/${encodeURIComponent(r.id)}`, { method: 'DELETE', headers: authHeaders(false) }).catch(() => {});
}

$('back-to-sectors').addEventListener('click', async () => {
  await cancelReservation();
  try {
    state.event = await loadEventDetail(state.event.id);
  } catch (e) { /* mantém o que já tinha */ }
  renderStep2();
  showStep(2);
});

/* ---------- Etapa 3: Revisão do Pedido ---------- */
function renderStep3() {
  const userInfoBox = $('logged-user-info');
  if (userInfoBox && state.user) {
    userInfoBox.innerHTML = `
      <div class="logged-card">
        <div class="logged-avatar">👤</div>
        <div class="logged-details">
          <small>Titular do Ingresso</small>
          <h4>${esc(state.user.name)}</h4>
          <p>${esc(state.user.email)}</p>
        </div>
      </div>`;
  }
  $('summary-3').innerHTML = summaryHtml(true);
  $('step3-error').classList.add('hidden');
}

/* ---------- Confirmar Compra (Etapa 3 -> 4) ---------- */
$('confirm-order').addEventListener('click', async () => {
  if (!state.reservation) return;
  const btn = $('confirm-order');
  const err = $('step3-error');
  btn.disabled = true;
  btn.textContent = 'Processando pedido...';
  err.classList.add('hidden');

  try {
    const res = await fetch(`${API}/orders`, {
      method: 'POST',
      headers: authHeaders(),
      // Nome e e-mail do comprador vêm do token no servidor; aqui só vai a reserva.
      body: JSON.stringify({ reservationId: state.reservation.id })
    });
    if (res.status === 401) handleExpiredSession(() => renderStep3());
    const body = await res.json().catch(() => ({}));
    if (res.status === 410) {
      state.reservation = null;
      stopTimer();
      renderTimer();
      throw new Error(body.message || 'Sua reserva expirou.');
    }
    if (!res.ok) throw new Error(body.message || 'Não foi possível concluir a compra.');

    stopTimer();
    state.reservation = null;
    state.order = body.order;
    renderTicket();
    showStep(4);
    renderDelivery();
    loadEvents().then(renderGames).catch(() => {});
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = !state.reservation;
    btn.textContent = 'Confirmar compra ✓';
  }
});

/* ---------- Etapa 4: Ticket do Ingresso ---------- */
function renderTicket() {
  const ev = state.event;
  const o = state.order;

  $('ticket').innerHTML = `
    <div class="ticket-main">
      <div class="ticket-header-tag">INGRESSO OFICIAL DIGITAL</div>
      <h3 class="ticket-teams">${esc(ev.teamHome)} × ${esc(ev.teamAway)}</h3>
      <p class="ticket-stadium-line">🏟️ <strong>${esc(ev.stadium || 'Estádio')}</strong></p>
      <p class="ticket-time-line">📅 ${esc(formatGameDate(ev.date))} · ⏰ <strong>${esc(formatGameTime(ev.date))}</strong></p>
      <p class="ticket-sector-line">🎟️ ${esc(o.quantity)} × ${esc(o.sectorName || ev.category)}</p>
      <p class="ticket-owner-line">👤 Titular: <strong>${esc(o.customerName)}</strong> (${esc(o.customerEmail)})</p>
      <p class="ticket-total-line">Total Pago: ${money(o.total)}</p>
    </div>
    <div class="ticket-stub">
      <small>CÓDIGO LOCALIZADOR</small>
      <div class="code">${esc(o.id)}</div>
      <small>${esc(o.quantity)} ingresso(s)</small>
      <div class="ticket-qr-placeholder">QR code no PDF</div>
    </div>
  `;
}

// Como o ingresso chega ao cliente: PDF (gerado pelo worker) e e-mail (SNS)
async function renderDelivery() {
  const box = $('ticket-delivery');
  box.textContent = 'Gerando o PDF do seu ingresso...';
  try {
    const res = await fetch(`${API}/users/me/email-notifications`, { headers: authHeaders(false) });
    const { status } = await res.json();
    const email = esc(state.user?.email || '');
    const messages = {
      confirmed: `📧 Enviamos o ingresso para <strong>${email}</strong>. Ele também fica em <a href="/meus-ingressos.html">Meus ingressos</a>.`,
      pending: `📧 Para receber o ingresso por e-mail, confirme a mensagem <strong>“AWS Notification - Subscription Confirmation”</strong> enviada para ${email} (veja também o spam). Depois disso, as próximas compras chegam automaticamente.`,
      none: '📧 As notificações por e-mail não estão ativas. Ative em <a href="/meus-ingressos.html">Meus ingressos</a>.',
      local: '📧 Ambiente local: o e-mail de confirmação foi gravado em <code>backend/data/outbox</code>.'
    };
    box.innerHTML = messages[status] || messages.none;
  } catch (e) {
    box.innerHTML = 'Seu ingresso fica disponível em <a href="/meus-ingressos.html">Meus ingressos</a>.';
  }
}

// Baixa o PDF; se o worker ainda estiver gerando, tenta de novo por alguns segundos
async function downloadTicket(orderId, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/ticket`, { headers: authHeaders(false) });
      if (res.status === 401) handleExpiredSession();
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.downloadUrl) {
        window.open(body.downloadUrl, '_blank', 'noopener');
        return;
      }
      if (res.status !== 202) throw new Error(body.message || 'Não foi possível baixar o ingresso.');
      button.textContent = 'Gerando PDF...';
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('O PDF ainda está sendo gerado. Tente novamente em instantes.');
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('download-pdf').addEventListener('click', (e) => {
  if (state.order) downloadTicket(state.order.id, e.currentTarget);
});

/* ---------- Novo Pedido / Voltar ao Início ---------- */
$('new-purchase').addEventListener('click', () => {
  state.event = null;
  state.sector = null;
  state.reservation = null;
  state.quantity = 1;
  state.order = null;
  renderGames();
  showStep(1);
});

/* ---------- Redirecionamento vindo de outras telas (ex.: "Meus ingressos") ---------- */
// Só aceita caminhos internos (começando com uma única "/"), para não virar redirecionamento aberto.
function safeNextPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && /^\/(?!\/)/.test(next) ? next : null;
}

function handleLoginRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('login') !== '1') return;
  const next = safeNextPath();
  if (state.user) {
    if (next) window.location.replace(next);
    return;
  }
  openAuthModal(next ? () => window.location.replace(next) : undefined);
}

/* ---------- Inicialização ---------- */
(async function init() {
  loadSavedUser();
  renderUserNav();
  handleLoginRedirect();
  try {
    await loadEvents();
  } catch (e) {
    $('game-list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
  renderGames();
  showStep(1);
  window.scrollTo(0, 0);
})();
