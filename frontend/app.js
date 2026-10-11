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
    } else if (state.event) {
      renderStep3();
      showStep(3);
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
    } else if (state.event) {
      renderStep3();
      showStep(3);
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
      state.event = selected;
      state.quantity = 1;
      renderStep2();
      showStep(2);
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

/* ---------- Resumo do Pedido ---------- */
function summaryHtml(withBuyer) {
  const ev = state.event;
  if (!ev) return '';
  const stadiumName = ev.stadium || 'Estádio';
  const rows = [
    ['Jogo', `${ev.teamHome} x ${ev.teamAway}`],
    ['Estádio', stadiumName],
    ['Data', formatGameDate(ev.date)],
    ['Horário', formatGameTime(ev.date)],
    ['Setor', ev.category],
    ['Preço unitário', money(ev.price)],
    ['Quantidade', state.quantity]
  ];
  if (withBuyer && state.user) {
    rows.push(['Titular', state.user.name], ['E-mail', state.user.email]);
  }
  return `
    <h3>Resumo do Pedido</h3>
    ${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
    <div class="row total"><span>Total</span><span>${money(ev.price * state.quantity)}</span></div>
  `;
}

/* ---------- Etapa 2: Apenas Quantidade de Ingressos ---------- */
function renderStep2() {
  const ev = state.event;
  if (!ev) return;
  const max = Math.min(MAX_PER_ORDER, ev.available);
  state.quantity = Math.min(state.quantity, max) || 1;

  const preview = $('selected-game-preview');
  if (preview) {
    preview.innerHTML = `
      <div class="preview-content">
        <span class="preview-tag">Jogo Selecionado</span>
        <h3>${esc(ev.teamHome)} × ${esc(ev.teamAway)}</h3>
        <p>🏟️ <strong>${esc(ev.stadium)}</strong> · 📅 ${esc(formatGameDate(ev.date))} às ⏰ <strong>${esc(formatGameTime(ev.date))}</strong></p>
      </div>
    `;
  }

  $('qty-value').textContent = state.quantity;
  $('qty-hint').textContent = `Máximo de ${max} ingresso(s) por compra.`;
  $('summary-2').innerHTML = summaryHtml(false);
  $('step2-error').classList.add('hidden');

  // Indicador de autenticação na etapa 2
  const authInd = $('step2-auth-indicator');
  if (state.user) {
    authInd.innerHTML = `
      <div class="auth-box-status logged">
        <span class="auth-icon-check">✓</span>
        <div>
          <strong>Identificado como:</strong> ${esc(state.user.name)} (${esc(state.user.email)})
          <button type="button" class="btn-link" id="btn-step2-logout">Trocar de conta</button>
        </div>
      </div>
    `;
    $('btn-step2-logout').addEventListener('click', logoutUser);
  } else {
    authInd.innerHTML = `
      <div class="auth-box-status not-logged">
        <span class="auth-icon-lock">🔒</span>
        <div>
          Ao clicar no botão de comprar, revisaremos se você já está conectado ou abriremos o login/cadastro para vincular seus ingressos.
        </div>
      </div>
    `;
  }
}

function changeQty(delta) {
  if (!state.event) return;
  const max = Math.min(MAX_PER_ORDER, state.event.available);
  state.quantity = Math.max(1, Math.min(max, state.quantity + delta));
  $('qty-value').textContent = state.quantity;
  $('summary-2').innerHTML = summaryHtml(false);
}

$('qty-minus').addEventListener('click', () => changeQty(-1));
$('qty-plus').addEventListener('click', () => changeQty(1));

/* ---------- Ação do botão Comprar/Revisar (Revisa se está logado!) ---------- */
$('to-review').addEventListener('click', () => {
  // Revisa se a pessoa está logada
  if (!state.user) {
    // Não está logada: abre modal para se autenticar
    openAuthModal(() => {
      renderStep3();
      showStep(3);
    });
    return;
  }

  // Já está logada: avança direto para a revisão do pedido
  renderStep3();
  showStep(3);
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
        <button type="button" class="btn-link" id="btn-step3-switch">Trocar conta</button>
      </div>
    `;
    $('btn-step3-switch').addEventListener('click', () => {
      openAuthModal(() => {
        renderStep3();
      });
    });
  }

  $('summary-3').innerHTML = summaryHtml(true);
  $('step3-error').classList.add('hidden');
}

/* ---------- Confirmar Compra (Etapa 3 -> 4) ---------- */
$('confirm-order').addEventListener('click', async () => {
  if (!state.user) {
    openAuthModal(() => {
      renderStep3();
    });
    return;
  }

  const btn = $('confirm-order');
  const err = $('step3-error');
  btn.disabled = true;
  btn.textContent = 'Processando pedido...';
  err.classList.add('hidden');

  try {
    const res = await fetch(`${API}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: state.event.id,
        quantity: state.quantity,
        customerName: state.user.name,
        customerEmail: state.user.email
      })
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Não foi possível concluir a compra.');

    state.order = body.order;
    renderTicket();
    showStep(4);
    loadEvents().then(renderGames).catch(() => {});
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
    loadEvents().then(() => {
      const fresh = state.events.find((x) => x.id === state.event?.id);
      if (fresh) state.event = fresh;
    }).catch(() => {});
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar compra ✓';
  }
});

/* ---------- Etapa 4: Ticket do Ingresso ---------- */
function renderTicket() {
  const ev = state.event;
  const o = state.order;
  const stadiumName = ev.stadium || 'Estádio';

  $('ticket').innerHTML = `
    <div class="ticket-main">
      <div class="ticket-header-tag">INGRESSO OFICIAL DIGITAL</div>
      <h3 class="ticket-teams">${esc(ev.teamHome)} × ${esc(ev.teamAway)}</h3>
      <p class="ticket-stadium-line">🏟️ <strong>${esc(stadiumName)}</strong></p>
      <p class="ticket-time-line">📅 ${esc(formatGameDate(ev.date))} · ⏰ <strong>${esc(formatGameTime(ev.date))}</strong></p>
      <p class="ticket-sector-line">🎟️ ${esc(o.quantity)} × ${esc(ev.category)}</p>
      <p class="ticket-owner-line">👤 Titular: <strong>${esc(o.customerName)}</strong> (${esc(o.customerEmail)})</p>
      <p class="ticket-total-line">Total Pago: ${money(o.total)}</p>
    </div>
    <div class="ticket-stub">
      <small>CÓDIGO LOCALIZADOR</small>
      <div class="code">${esc(o.id)}</div>
      <small>${esc(o.quantity)} ingresso(s)</small>
      <div class="ticket-qr-placeholder">⚽ QR CODE</div>
    </div>
  `;
}

/* ---------- Novo Pedido / Voltar ao Início ---------- */
$('new-purchase').addEventListener('click', () => {
  state.event = null;
  state.quantity = 1;
  state.order = null;
  renderGames();
  showStep(1);
});

/* ---------- Inicialização ---------- */
(async function init() {
  loadSavedUser();
  renderUserNav();
  try {
    await loadEvents();
  } catch (e) {
    $('game-list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
  renderGames();
  showStep(1);
  window.scrollTo(0, 0);
})();
