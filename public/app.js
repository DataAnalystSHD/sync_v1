// ════════════════════════════════════════════════════
// SHD Sync — Frontend
// ════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────
const CONFIG = { historySheetId: null, allowedDomain: null };

const state = {
  refreshToken: localStorage.getItem('google_refresh_token') || '',
  userEmail:    localStorage.getItem('google_user_email')    || '',
  masterMode:   'lark-to-sheet',
};

// ──────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────
function log(...args) {
  const s = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
  const box = $('log');
  box.textContent = (box.textContent === '— ready —' ? '' : box.textContent + '\n')
    + `[${new Date().toLocaleTimeString()}] ` + s;
  box.scrollTop = box.scrollHeight;
  console.log(...args);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ──────────────────────────────────────────────────
// Notifications
// ──────────────────────────────────────────────────
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '' }); } catch {}
  }
}

// ──────────────────────────────────────────────────
// Confirm modal
// ──────────────────────────────────────────────────
function showConfirm({ iconName, title, desc, confirmText, confirmClass }) {
  return new Promise(resolve => {
    $('modalIcon').innerHTML    = icon(iconName || 'alertTriangle', 40);
    $('modalTitle').textContent = title || 'Confirm';
    $('modalDesc').innerHTML    = desc || '';
    $('modalConfirm').textContent = confirmText || 'Confirm';
    $('modalConfirm').className   = confirmClass || 'danger';
    $('confirmModal').classList.add('show');

    const cleanup = (val) => {
      $('confirmModal').classList.remove('show');
      $('modalConfirm').onclick = null;
      $('modalCancel').onclick  = null;
      resolve(val);
    };
    $('modalConfirm').onclick = () => cleanup(true);
    $('modalCancel').onclick  = () => cleanup(false);
  });
}

// ──────────────────────────────────────────────────
// Auth UI
// ──────────────────────────────────────────────────
function setAuthed(ok) {
  $('btnLogout').disabled       = !ok;
  $('sheetUrl').disabled        = !ok;
  $('larkUrl').disabled         = !ok;
  $('syncDirection').disabled   = !ok;
  $('btnSyncNow').disabled      = !ok;

  const chip = $('authChip');
  if (ok) {
    chip.innerHTML = `<div class="user-dot"></div>${escHtml(state.userEmail)}`;
    chip.className = 'user-badge active';
    requestNotifPermission();
  } else {
    chip.innerHTML = '<div class="user-dot"></div>Not signed in';
    chip.className = 'user-badge';
  }
  updateInfoRow();
}

function updateInfoRow() {
  $('iUser').textContent = state.userEmail || 'Not signed in';
  const userCard = $('iUser').closest('.info-card');
  if (userCard) userCard.dataset.color = state.userEmail ? 'green' : 'gray';

  $('iMode').textContent = DIRECTION_LABELS[state.masterMode] || state.masterMode;

  const status = $('iStatus');
  const statusCard = status.closest('.info-card');
  if (state.userEmail) {
    status.textContent = 'Connected';
    if (statusCard) statusCard.dataset.color = 'green';
  } else {
    status.textContent = 'Disconnected';
    if (statusCard) statusCard.dataset.color = 'gray';
  }
}

const DIRECTION_LABELS = {
  'lark-to-sheet':            'Lark Base → Google Sheet',
  'sheet-to-lark':            'Google Sheet → Lark Base',
  'larksheet-to-larkbase':    'Lark Sheet → Lark Base',
  'larkbase-to-larksheet':    'Lark Base → Lark Sheet',
  'larksheet-to-googlesheet': 'Lark Sheet → Google Sheet',
  'googlesheet-to-larksheet': 'Google Sheet → Lark Sheet',
};

const URL_KIND = {
  google:    { label: 'Google Sheet URL',     placeholder: 'https://docs.google.com/spreadsheets/d/...' },
  larkSheet: { label: 'Lark Sheet URL',       placeholder: 'https://...feishu.cn/wiki/<token> หรือ /sheets/<token>' },
  larkBase:  { label: 'Lark / Feishu Base URL', placeholder: 'https://...larksuite.com/base/<baseId>?table=<tableId>' },
};

// For each direction, what does the top input (sheetUrl) and bottom input (larkUrl) hold?
const FIELD_KINDS = {
  'lark-to-sheet':            { top: 'google',    bottom: 'larkBase'  },
  'sheet-to-lark':            { top: 'google',    bottom: 'larkBase'  },
  'larksheet-to-larkbase':    { top: 'larkSheet', bottom: 'larkBase'  },
  'larkbase-to-larksheet':    { top: 'larkSheet', bottom: 'larkBase'  },
  'larksheet-to-googlesheet': { top: 'larkSheet', bottom: 'google'    },
  'googlesheet-to-larksheet': { top: 'google',    bottom: 'larkSheet' },
};

function setMode(m) {
  if (!DIRECTION_LABELS[m]) m = 'lark-to-sheet';
  state.masterMode = m;
  if ($('syncDirection').value !== m) $('syncDirection').value = m;

  const kinds = FIELD_KINDS[m];
  const top = URL_KIND[kinds.top];
  const bot = URL_KIND[kinds.bottom];
  $('sheetUrlLabel').textContent = top.label;
  $('sheetUrl').placeholder      = top.placeholder;
  $('larkUrlLabel').textContent  = bot.label;
  $('larkUrl').placeholder       = bot.placeholder;
  updateInfoRow();
}

// ──────────────────────────────────────────────────
// OAuth popup flow
// ──────────────────────────────────────────────────
function openPopup(url) {
  const w = 520, h = 680;
  const y = window.top.outerHeight / 2 + window.top.screenY - h / 2;
  const x = window.top.outerWidth  / 2 + window.top.screenX - w / 2;
  return window.open(url, 'shd_oauth', `width=${w},height=${h},top=${y},left=${x}`);
}

function startLogin() {
  log('Opening Google login...');
  const p = openPopup('/api/auth/google/start');
  if (!p) alert('Popup blocked — please allow popups');
}

async function onOauthMessage(ev) {
  if (ev?.data?.type !== 'shd_google_oauth') return;
  const msg = ev.data;
  if (msg.ok) {
    state.refreshToken = msg.refresh_token || '';
    state.userEmail    = msg.email || '';
    if (!state.refreshToken) { alert('No refresh_token received. Try login again.'); return; }
    localStorage.setItem('google_refresh_token', state.refreshToken);
    localStorage.setItem('google_user_email',    state.userEmail);
    log('[OK] Logged in as ' + state.userEmail);
    setAuthed(true);
  } else {
    log('[ERR] Login failed: ' + msg.error);
    alert('Login failed: ' + msg.error);
  }
}

function logout() {
  localStorage.removeItem('google_refresh_token');
  localStorage.removeItem('google_user_email');
  state.refreshToken = '';
  state.userEmail    = '';
  setAuthed(false);
  log('Logged out');
}

// ──────────────────────────────────────────────────
// Sync
// ──────────────────────────────────────────────────
function getInputs() {
  const s = $('sheetUrl').value.trim();
  const l = $('larkUrl').value.trim();
  if (!s || !l) throw new Error('กรุณาใส่ลิงก์ให้ครบ');
  return { sheetUrl: s, larkUrl: l, direction: state.masterMode };
}

async function syncNow() {
  const ok = await showConfirm({
    iconName: 'alertTriangle',
    title: 'Full-replace Sync',
    desc: 'ข้อมูล<b>ปลายทางจะถูกลบทั้งหมด</b>แล้ว sync ใหม่<br>ต้องการดำเนินการ?',
    confirmText: 'Sync Now',
    confirmClass: 'primary',
  });
  if (!ok) return;
  try {
    const { refreshToken, userEmail } = state;
    log('Manual sync...');
    const out = await fetchJson('/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        pairs: [{ ...getInputs(), refreshToken, userEmail, source: 'manual', forceNew: true }],
      }),
    });
    log('[OK] Sync result', out);
    sendNotif('SHD Sync', 'Manual sync completed');
  } catch (e) {
    log('[ERR] Sync error: ' + e.message);
    sendNotif('SHD Sync', 'Sync failed: ' + e.message);
    alert(e.message);
  }
}

// ──────────────────────────────────────────────────
// How-to toggle
// ──────────────────────────────────────────────────
function toggleHowto() {
  const body = $('howtoBody');
  const btn  = $('howtoToggleBtn');
  const collapsed = body.classList.toggle('collapsed');
  btn.innerHTML = collapsed
    ? `${icon('chevronDown', 14)} ขยาย`
    : `${icon('chevronUp', 14)} ย่อ`;
}

// ──────────────────────────────────────────────────
// Logs export/clear
// ──────────────────────────────────────────────────
function exportLogs() {
  const text = $('log').textContent;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shd-sync-log-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  log('Exported logs');
}

function clearLogs() {
  $('log').textContent = '— ready —';
}

// ──────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────
async function bootstrap() {
  try {
    const cfg = await fetchJson('/api/config');
    CONFIG.historySheetId = cfg.historySheetId;
    CONFIG.allowedDomain  = cfg.allowedDomain;
    $('histLabel').textContent = cfg.historySheetId || '(missing)';
    log('Config loaded', cfg);
  } catch (e) {
    log('Config error: ' + e.message);
  }

  if (state.refreshToken && state.userEmail) {
    setAuthed(true);
  } else {
    updateInfoRow();
  }
}

function bindEvents() {
  $('btnLogin').onclick    = startLogin;
  $('btnLogout').onclick   = logout;
  $('syncDirection').onchange = (ev) => setMode(ev.target.value);
  $('btnSyncNow').onclick  = syncNow;
  $('btnClearLog').onclick   = clearLogs;
  $('btnExportLog').onclick  = exportLogs;
  $('howtoSection').querySelector('.howto-hd').onclick = toggleHowto;
  $('howtoToggleBtn').onclick = (ev) => { ev.stopPropagation(); toggleHowto(); };

  window.addEventListener('message', onOauthMessage);
}

bindEvents();
bootstrap();
