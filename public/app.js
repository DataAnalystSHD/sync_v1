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
  $('rowFrom').disabled         = !ok;
  $('rowTo').disabled           = !ok;
  $('syncMode').disabled        = !ok;
  $('syncInterval').disabled    = !ok;
  $('btnSyncNow').disabled      = !ok;
  $('btnSaveCron').disabled     = !ok;

  const chip = $('authChip');
  if (ok) {
    chip.innerHTML = `<div class="user-dot"></div>${escHtml(state.userEmail)}`;
    chip.className = 'user-badge active';
    requestNotifPermission();
    loadPairs();
  } else {
    chip.innerHTML = '<div class="user-dot"></div>Not signed in';
    chip.className = 'user-badge';
    renderPairs([]);
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
function parseRow(v){
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function getInputs() {
  const s = $('sheetUrl').value.trim();
  const l = $('larkUrl').value.trim();
  if (!s || !l) throw new Error('กรุณาใส่ลิงก์ให้ครบ');
  const rowFrom = parseRow($('rowFrom').value);
  const rowTo   = parseRow($('rowTo').value);
  if (rowFrom && rowTo && rowTo < rowFrom) {
    throw new Error('Row Range: "To" ต้อง ≥ "From"');
  }
  const syncMode = $('syncMode').value === 'append' ? 'append' : 'replace';
  return {
    sheetUrl: s, larkUrl: l, direction: state.masterMode,
    rowFrom, rowTo, syncMode,
  };
}

function resetForm() {
  $('sheetUrl').value = '';
  $('larkUrl').value  = '';
  $('rowFrom').value  = '';
  $('rowTo').value    = '';
  $('syncMode').value = 'replace';
  setMode('lark-to-sheet');
  log('Form reset');
}

async function syncNow() {
  const isAppend = $('syncMode').value === 'append';
  const ok = await showConfirm({
    iconName: 'alertTriangle',
    title: isAppend ? 'Append Sync' : 'Full-replace Sync',
    desc: isAppend
      ? 'จะ <b>เพิ่มข้อมูลต่อท้าย</b>ข้อมูลที่มีอยู่<br>ไม่ลบของเดิม ต้องการดำเนินการ?'
      : 'ข้อมูล<b>ปลายทางจะถูกลบทั้งหมด</b>แล้ว sync ใหม่<br>ต้องการดำเนินการ?',
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
// Cron Manager (auto-sync schedules)
// ──────────────────────────────────────────────────
const INTERVAL_LABELS = {
  5: 'ทุก 5 นาที', 15: 'ทุก 15 นาที', 30: 'ทุก 30 นาที', 60: 'ทุก 1 ชม.',
  120: 'ทุก 2 ชม.', 360: 'ทุก 6 ชม.', 720: 'ทุก 12 ชม.', 1440: 'ทุกวัน',
};

let cronPairs = [];

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

function nextRunLabel(p) {
  if (!p.active) return 'paused';
  if (!p.lastSyncAt) return 'รอบถัดไป';
  const last = new Date(p.lastSyncAt).getTime();
  if (isNaN(last)) return 'รอบถัดไป';
  const next = last + (p.intervalMin || 60) * 60000;
  const diff = next - Date.now();
  if (diff <= 0) return 'ครบกำหนดแล้ว';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `อีก ~${mins} นาที`;
  return `อีก ~${Math.round(mins / 60)} ชม.`;
}

async function loadPairs() {
  if (!state.refreshToken) return;
  try {
    const out = await fetchJson('/api/pairs', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    cronPairs = out.pairs || [];
    renderPairs(cronPairs);
  } catch (e) {
    log('[ERR] Load auto-sync list: ' + e.message);
  }
}

function renderPairs(pairs) {
  const list = $('cronList');
  const empty = $('cronEmpty');
  list.innerHTML = '';
  if (!pairs || pairs.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  for (const p of pairs) {
    const row = document.createElement('div');
    row.className = 'cron-row' + (p.active ? '' : ' off');
    const dirLabel = DIRECTION_LABELS[p.direction] || p.direction;
    row.innerHTML = `
      <button class="cron-toggle ${p.active ? 'on' : ''}" data-act="toggle" data-row="${p.rowId}" title="${p.active ? 'Active — กดเพื่อหยุด' : 'Paused — กดเพื่อเปิด'}">
        <span class="cron-knob"></span>
      </button>
      <div class="cron-info">
        <div class="cron-title">${escHtml(dirLabel)}</div>
        <div class="cron-meta">
          <span class="cron-tag">${icon('clock', 11)} ${INTERVAL_LABELS[p.intervalMin] || (p.intervalMin + ' นาที')}</span>
          <span class="cron-tag ${p.syncMode === 'append' ? 'info' : 'warn'}">${p.syncMode === 'append' ? 'Append' : 'Replace'}</span>
          <span class="cron-sub">last: ${fmtTime(p.lastSyncAt)} · ${nextRunLabel(p)}</span>
        </div>
        <div class="cron-urls">${escHtml(p.sheetUrl)}<br>${escHtml(p.larkUrl)}</div>
      </div>
      <div class="cron-actions">
        <button class="cron-run" data-act="run" data-row="${p.rowId}">${icon('play', 13)} Run now</button>
        <button class="cron-del" data-act="del" data-row="${p.rowId}" title="ลบงานนี้">${icon('trash', 13)}</button>
      </div>`;
    list.appendChild(row);
  }

  list.querySelectorAll('[data-act]').forEach(btn => {
    const rowId = parseInt(btn.dataset.row, 10);
    const act = btn.dataset.act;
    btn.onclick = () => {
      if (act === 'toggle') togglePair(rowId);
      else if (act === 'run') runPairNow(rowId, btn);
      else if (act === 'del') deletePair(rowId);
    };
  });
}

async function saveCron() {
  try {
    const inputs = getInputs();
    const intervalMin = parseInt($('syncInterval').value, 10) || 60;
    const { refreshToken, userEmail } = state;
    log(`Saving auto-sync (${INTERVAL_LABELS[intervalMin] || intervalMin + ' นาที'})...`);
    await fetchJson('/api/pairs', {
      method: 'POST',
      body: JSON.stringify({ ...inputs, intervalMin, refreshToken, userEmail }),
    });
    log('[OK] Auto-sync saved');
    sendNotif('SHD Sync', 'Auto-sync schedule saved');
    await loadPairs();
  } catch (e) {
    log('[ERR] Save auto-sync: ' + e.message);
    alert(e.message);
  }
}

async function togglePair(rowId) {
  const p = cronPairs.find(x => x.rowId === rowId);
  if (!p) return;
  try {
    await fetchJson('/api/pairs', {
      method: 'PUT',
      body: JSON.stringify({ rowId, active: !p.active, refreshToken: state.refreshToken }),
    });
    log(`[OK] ${!p.active ? 'Enabled' : 'Paused'} auto-sync #${rowId}`);
    await loadPairs();
  } catch (e) {
    log('[ERR] Toggle: ' + e.message);
    alert(e.message);
  }
}

async function runPairNow(rowId, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('refreshCw', 13)} Running...`; }
  try {
    log(`Running auto-sync #${rowId} now...`);
    const out = await fetchJson('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ runRowId: rowId, refreshToken: state.refreshToken }),
    });
    const r = (out.results || [])[0] || {};
    if (r.status === 'error') log('[ERR] Run result: ' + r.error);
    else log('[OK] Run result', out);
    sendNotif('SHD Sync', `Run now #${rowId}: ${r.status || 'done'}`);
    await loadPairs();
  } catch (e) {
    log('[ERR] Run now: ' + e.message);
    alert(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('play', 13)} Run now`; }
  }
}

async function deletePair(rowId) {
  const ok = await showConfirm({
    iconName: 'trash',
    title: 'ลบงาน Auto-sync',
    desc: 'จะลบงานซิงค์อัตโนมัตินี้ออก (ไม่กระทบข้อมูลที่ซิงค์ไปแล้ว)<br>ต้องการดำเนินการ?',
    confirmText: 'Delete',
    confirmClass: 'danger',
  });
  if (!ok) return;
  try {
    await fetchJson('/api/pairs', {
      method: 'DELETE',
      body: JSON.stringify({ rowId, refreshToken: state.refreshToken }),
    });
    log(`[OK] Deleted auto-sync #${rowId}`);
    await loadPairs();
  } catch (e) {
    log('[ERR] Delete: ' + e.message);
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
  $('btnSaveCron').onclick = saveCron;
  $('btnReloadCron').onclick = loadPairs;
  $('btnReset').onclick    = resetForm;
  $('btnClearLog').onclick   = clearLogs;
  $('btnExportLog').onclick  = exportLogs;
  $('howtoSection').querySelector('.howto-hd').onclick = toggleHowto;
  $('howtoToggleBtn').onclick = (ev) => { ev.stopPropagation(); toggleHowto(); };

  window.addEventListener('message', onOauthMessage);
}

bindEvents();
bootstrap();
