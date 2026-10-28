/* VillaForge · Mobile-First App-Logik (v1.57.1)
   Übersicht / Chat / Agenten / Konto + Vollbild-Arbeitsraum.
   Alle Touch-Targets ≥44px, SSE-Live-Updates, Offline-freundlich. */
const $ = (s) => document.querySelector(s);
let vfToken = localStorage.getItem('vf_token') || '';
let currentVilla = null;
let currentAgentId = null;
let latestVillas = [];
let latestFocusVillaId = null;
let activityTicks = [];
let dashboardActionsLoadedAt = 0;
let activeDetailLoadedAt = 0;
let activeDetailVillaId = null;

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(vfToken ? { Authorization: 'Bearer ' + vfToken } : {}) }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  if (res.status === 401) { vfToken = ''; localStorage.removeItem('vf_token'); showLogin('Login erforderlich.'); }
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(window.vfToastT); window.vfToastT = setTimeout(() => { t.hidden = true; }, 2600); }

/* ---------- Login ---------- */
function showLogin(msg = 'Melde dich an, um weiterzuarbeiten.') { const o = $('#loginOverlay'); if (o) { o.hidden = false; $('#loginMsg').textContent = msg; } }
function hideLogin() { const o = $('#loginOverlay'); if (o) o.hidden = true; }
async function doLogin() {
  const email = $('#loginEmail').value.trim(), password = $('#loginPassword').value;
  if (!email || !password) { $('#loginMsg').textContent = 'Bitte E-Mail und Passwort eingeben.'; return; }
  $('#loginBtn').disabled = true; $('#loginMsg').textContent = 'Anmeldung läuft …';
  try {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const out = await res.json();
    if (out.token) { vfToken = out.token; localStorage.setItem('vf_token', vfToken); hideLogin(); $('#loginMsg').textContent = ''; $('#loginPassword').value = ''; boot(); }
    else { $('#loginMsg').textContent = out.error || 'Anmeldung fehlgeschlagen.'; }
  } catch (e) { $('#loginMsg').textContent = String(e); }
  finally { $('#loginBtn').disabled = false; }
}
async function checkSession() {
  try {
    const me = await api('/api/auth/me');
    if (me.user) {
      hideLogin();
      const label = me.user.name || me.user.email || 'Mein Konto';
      $('#accountName').textContent = label;
      $('#accountDetail').textContent = me.user.email && me.user.name ? me.user.email : 'Angemeldet · VillaForge';
      const initial = String(label).trim().charAt(0).toLocaleUpperCase('de-DE');
      if (initial) document.querySelectorAll('.avatar').forEach(el => { el.textContent = initial; });
    } else {
      $('#accountName').textContent = 'Mein Konto';
      $('#accountDetail').textContent = 'Nicht angemeldet';
    }
  } catch {}
}

/* ---------- Navigation (Bottom-Tabs) ---------- */
function selectView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.bottomnav .nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  window.scrollTo({ top: 0 });
}

/* ---------- Health & Kennzahlen ---------- */
async function checkHealth() {
  try {
    const h = await api('/api/health');
    $('#healthDot').className = 'dot ok';
    $('#healthText').textContent = `Hub online · ${h.routes} Routen · v${h.version || ''}`;
    $('#systemBadge').className = 'badge online'; $('#systemBadge').textContent = '● Hub online';
    $('.quality-card').classList.remove('is-offline');
    $('#gateChip').class