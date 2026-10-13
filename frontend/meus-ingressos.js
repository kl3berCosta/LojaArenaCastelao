// Tela "Meus ingressos": lista os pedidos do usuário logado (GET /orders/mine).
const API = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
const USER_KEY = 'ticket_user';
const TOKEN_KEY = 'ticket_token';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatPurchase(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function savedUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch (e) {
    return null;
  }
}

function logout() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = '/';
}

function renderUserNav(user) {
  $('user-nav').innerHTML = user
    ? `<div class="user-session">
         <span class="user-pill">👤 <strong>${esc(user.name)}</strong></span>
         <button type="button" class="btn-logout" id="btn-logout" title="Sair da conta">Sair</button>
       </div>`
    : `<a class="btn-auth-trigger" href="/?login=1&next=/meus-ingressos.html">👤 Entrar / Cadastrar</a>`;
  const out = $('btn-logout');
  if (out) out.addEventListener('click', logout);
}

function showLoginRequired() {
  $('my-area').classList.add('hidden');
  $('login-required').classList.remove('hidden');
}

function ticketCard(o) {
  const ev = o.event;
  const teams = ev ? `${esc(ev.teamHome)} × ${esc(ev.teamAway)}` : esc(o.eventName || 'Jogo');
  const image = ev && ev.imageUrl
    ? `<img class="my-ticket-img" src="${esc(ev.imageUrl)}" alt="" onerror="this.remove()" />`
    : '';
  const when = ev
    ? `<p class="ticket-time-line">📅 ${esc(formatDate(ev.date))} · ⏰ <strong>${esc(formatTime(ev.date))}</strong></p>`
    : '<p class="ticket-time-line">Este jogo não está mais em cartaz, mas o seu pedido continua registrado.</p>';
  const where = ev ? `<p class="ticket-stadium-line">🏟️ <strong>${esc(ev.stadium)}</strong></p>` : '';
  const sector = `${esc(o.quantity)} × ${esc(o.sectorName || (ev && ev.category) || 'Ingresso')}`;

  return `
    <article class="ticket my-ticket">
      <div class="ticket-main">
        ${image}
        <div class="ticket-header-tag">INGRESSO OFICIAL DIGITAL</div>
        <h3 class="ticket-teams">${teams}</h3>
        ${where}
        ${when}
        <p class="ticket-sector-line">🎟️ ${sector}</p>
        <p class="ticket-owner-line">👤 Titular: <strong>${esc(o.customerName)}</strong></p>
        <p class="ticket-total-line">Total pago: ${money(o.total)}
          <span class="my-ticket-date">Comprado em ${esc(formatPurchase(o.createdAt))}</span></p>
      </div>
      <div class="ticket-stub">
        <small>Código localizador</small>
        <div class="code">${esc(o.id)}</div>
        <small>${esc(o.quantity)} ingresso(s)</small>
        <button type="button" class="btn btn-primary btn-sm" data-pdf="${esc(o.id)}">⬇ PDF com QR code</button>
      </div>
    </article>`;
}

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) || ''}` });

// Baixa o PDF do ingresso; se o worker ainda estiver gerando, tenta de novo por alguns segundos
async function downloadTicket(orderId, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/ticket`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.downloadUrl) {
        window.open(body.downloadUrl, '_blank', 'noopener');
        return;
      }
      if (res.status !== 202) throw new Error(body.message || 'Não foi possível baixar o ingresso.');
      button.textContent = 'Gerando...';
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

// Notificações por e-mail (SNS): mostra o estado e permite ativar / reenviar a confirmação
async function renderEmailCard() {
  const card = $('email-card');
  try {
    const res = await fetch(`${API}/users/me/email-notifications`, { headers: authHeaders() });
    if (!res.ok) return;
    const { status } = await res.json();
    const texts = {
      confirmed: '📧 Notificações por e-mail <strong>ativas</strong>: cada compra chega na sua caixa de entrada com o link do PDF.',
      pending: '📧 Falta confirmar: abra o e-mail <strong>“AWS Notification - Subscription Confirmation”</strong> (veja o spam) e clique em <em>Confirm subscription</em>.',
      none: '📧 Receba seus ingressos por e-mail a cada compra.',
      local: '📧 Ambiente local: os e-mails são gravados em <code>backend/data/outbox</code>.'
    };
    const action = status === 'pending' ? 'Reenviar confirmação' : status === 'none' ? 'Ativar e-mails' : '';
    card.innerHTML = `${texts[status] || texts.none}${action ? ` <button type="button" class="btn btn-ghost btn-sm" id="email-subscribe">${action}</button>` : ''}`;
    card.classList.remove('hidden');
    const btn = $('email-subscribe');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await fetch(`${API}/users/me/email-notifications`, { method: 'POST', headers: authHeaders() });
        const body = await r.json().catch(() => ({}));
        card.innerHTML = `📧 ${esc(body.message || 'Pronto! Verifique sua caixa de entrada.')}`;
      });
    }
  } catch (e) { /* cartão opcional */ }
}

function renderSummary(orders) {
  const tickets = orders.reduce((sum, o) => sum + Number(o.quantity), 0);
  const total = orders.reduce((sum, o) => sum + Number(o.total), 0);
  $('summary').innerHTML = `
    <div class="my-stat"><strong>${orders.length}</strong><span>pedido(s)</span></div>
    <div class="my-stat"><strong>${tickets}</strong><span>ingresso(s)</span></div>
    <div class="my-stat"><strong>${money(total)}</strong><span>investido</span></div>`;
}

async function load() {
  const user = savedUser();
  const token = localStorage.getItem(TOKEN_KEY);
  renderUserNav(token ? user : null);

  if (!token) return showLoginRequired();

  $('my-area').classList.remove('hidden');
  renderEmailCard();
  try {
    const res = await fetch(`${API}/orders/mine`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      // Sessão expirada ou token inválido
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(TOKEN_KEY);
      renderUserNav(null);
      return showLoginRequired();
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body)) throw new Error((body && body.message) || 'Não foi possível carregar seus ingressos.');

    $('loading').classList.add('hidden');
    if (body.length === 0) {
      $('empty').classList.remove('hidden');
      return;
    }
    renderSummary(body);
    $('tickets').innerHTML = body.map(ticketCard).join('');
    document.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => downloadTicket(b.dataset.pdf, b)));
  } catch (e) {
    $('loading').classList.add('hidden');
    $('error').textContent = e.message;
    $('error').classList.remove('hidden');
  }
}

load();
