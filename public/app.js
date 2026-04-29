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
  lastPairs:    [],
  syncedCount:  0,
  editingRowId: null,
  lastSyncTime: null,
  lastSyncOk:   0,
  lastSyncFail: 0,
  autoTimer:    null,
  cdTimer:      null,
  autoSecondsLeft: 0,
};

// ──────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────
function log(...args) {
  const s = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
  const box = $('log');
  box.textContent = (box.textContent === '\u2014 ready \u2014' ? '' : box.textContent + '\n')
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

function fmtTime(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

// ──────────────────────────────────────────────────
// Theme
// ──────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('shd_theme', theme);
  $('btnTheme').textContent = theme === 'dark' ? '\u263E' : '\u2600';
  $('btnTheme').title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
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
function showConfirm({ icon, title, desc, confirmText, confirmClass }) {
  return new Promise(resolve => {
    $('modalIcon').textContent  = icon || '\u26a0\ufe0f';
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
  $('btnLogout').disabled   = !ok;
  $('sheetUrl').disabled    = !ok;
  $('larkUrl').disabled     = !ok;
  $('btnSavePair').disabled = !ok;
  $('btnSyncNow').disabled  = !ok;
  $('btnReload').disabled   = !ok;
  $('btnSyncAll').disabled  = !ok;

  const chip = $('authChip');
  if (ok) {
    chip.innerHTML = `<div class="user-dot"></div>${escHtml(state.userEmail)}`;
    chip.className = 'user-badge active';
    requestNotifPermission();
  } else {
    chip.innerHTML = '<div class="user-dot"></div>Not signed in';
    chip.className = 'user-badge';
  }
  $('autoStartRow').style.display = ok ? 'block' : 'none';
  if (!ok) stopAutoSync();
  updateInfoRow();
}

function updateInfoRow() {
  $('iUser').textContent = state.userEmail || 'Not signed in';
  const userCard = $('iUser').closest('.info-card');
  if (userCard) userCard.dataset.color = state.userEmail ? 'green' : 'gray';

  $('iMode').textContent = (DIRECTION_LABELS[state.masterMode] || state.masterMode).replace(/^[^\s]+\s/, '');

  const status = $('iStatus');
  const statusCard = status.closest('.info-card');
  if (state.autoTimer) {
    status.textContent = 'Auto-sync ON';
    if (statusCard) statusCard.dataset.color = 'cyan';
  } else if (state.userEmail) {
    status.textContent = 'Connected';
    if (statusCard) statusCard.dataset.color = 'green';
  } else {
    status.textContent = 'Disconnected';
    if (statusCard) statusCard.dataset.color = 'gray';
  }
}

const DIRECTION_LABELS = {
  'lark-to-sheet':          '\u2b05 Lark Base \u2192 Google Sheet',
  'sheet-to-lark':          '\u27a1 Google Sheet \u2192 Lark Base',
  'larksheet-to-larkbase':  '\ud83d\udd00 Lark Sheet \u2192 Lark Base',
  'larkbase-to-larksheet':  '\ud83d\udd00 Lark Base \u2192 Lark Sheet',
};

function isLarkSourceMode(mode){
  return mode === 'larksheet-to-larkbase' || mode === 'larkbase-to-larksheet';
}

function setMode(m) {
  if (!DIRECTION_LABELS[m]) m = 'lark-to-sheet';
  state.masterMode = m;
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.dataset.active = btn.dataset.mode === m ? 'true' : 'false';
  });

  const lark = isLarkSourceMode(m);
  $('sheetUrlLabel').textContent = lark ? 'Lark Sheet URL' : 'Google Sheet URL';
  $('sheetUrl').placeholder = lark
    ? 'https://...feishu.cn/wiki/<token> หรือ /sheets/<token>'
    : 'https://docs.google.com/spreadsheets/d/...';
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
  if (!p) alert('Popup blocked \u2014 please allow popups');
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
    log('\u2705 Logged in as ' + state.userEmail);
    setAuthed(true);
    await loadPairs();
    startAutoSync();
  } else {
    log('\u274c Login failed: ' + msg.error);
    alert('Login failed: ' + msg.error);
  }
}

function logout() {
  stopAutoSync();
  localStorage.removeItem('google_refresh_token');
  localStorage.removeItem('google_user_email');
  state.refreshToken = '';
  state.userEmail    = '';
  state.lastPairs    = [];
  setAuthed(false);
  cancelEdit();
  $('pairsList').innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83d\udd17</div>Login \u0e41\u0e25\u0e49\u0e27 load pairs</div>';
  $('pairCount').textContent = '0 pairs';
  $('searchBar').style.display = 'none';
  hideSyncSummary();
  log('Logged out');
}

// ──────────────────────────────────────────────────
// Edit pair
// ──────────────────────────────────────────────────
function startEdit(pair) {
  state.editingRowId = pair.rowId;
  $('sheetUrl').value = pair.sheetUrl;
  $('larkUrl').value  = pair.larkUrl;
  setMode(pair.direction || 'lark-to-sheet');
  $('editBanner').classList.add('show');
  $('editRowId').textContent = pair.rowId;
  $('btnSavePair').textContent = '\u2714 Update Pair';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  state.editingRowId = null;
  $('editBanner').classList.remove('show');
  $('btnSavePair').innerHTML = '&#128190; Save Pair';
  $('sheetUrl').value = '';
  $('larkUrl').value  = '';
}

// ──────────────────────────────────────────────────
// Progress bar
// ──────────────────────────────────────────────────
function showProgress(current, total, text) {
  const wrap = $('progressWrap');
  wrap.classList.add('show');
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressPct').textContent  = pct + '%';
  $('progressText').textContent = text || 'Syncing...';
}

function hideProgress() {
  $('progressWrap').classList.remove('show');
  $('progressFill').style.width = '0%';
}

// ──────────────────────────────────────────────────
// Last sync summary
// ──────────────────────────────────────────────────
function updateSyncSummary() {
  const el = $('syncSummary');
  const total = state.lastSyncOk + state.lastSyncFail;
  if (!state.lastSyncTime || total === 0) { el.classList.remove('show'); return; }
  const timeStr = new Date(state.lastSyncTime).toLocaleString('th-TH');
  el.innerHTML = `\u26a1 Sync ล่าสุด: <b>${timeStr}</b> &mdash; สำเร็จ <b>${state.lastSyncOk}/${total}</b> pairs`
    + (state.lastSyncFail > 0 ? ` &mdash; <span style="color:var(--red)">ล้มเหลว ${state.lastSyncFail}</span>` : '');
  el.className = 'sync-summary show' + (state.lastSyncFail > 0 ? ' has-error' : '');
}

function hideSyncSummary() {
  $('syncSummary').classList.remove('show');
  state.lastSyncTime = null;
}

// ──────────────────────────────────────────────────
// Pair save / sync
// ──────────────────────────────────────────────────
function getInputs() {
  const s = $('sheetUrl').value.trim();
  const l = $('larkUrl').value.trim();
  if (!s || !l) throw new Error('\u0e01\u0e23\u0e38\u0e13\u0e32\u0e43\u0e2a\u0e48\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e43\u0e2b\u0e49\u0e04\u0e23\u0e1a');
  return { sheetUrl: s, larkUrl: l, direction: state.masterMode };
}

async function savePair() {
  try {
    const { refreshToken, userEmail } = state;
    if (state.editingRowId) {
      log('Updating pair #' + state.editingRowId + '...');
      await fetchJson('/api/pairs', {
        method: 'PUT',
        body: JSON.stringify({ refreshToken, rowId: state.editingRowId, active: false }),
      });
      const out = await fetchJson('/api/pairs', {
        method: 'POST',
        body: JSON.stringify({ ...getInputs(), refreshToken, userEmail }),
      });
      log('\u2705 Pair updated', out);
      cancelEdit();
    } else {
      log('Saving pair...');
      const out = await fetchJson('/api/pairs', {
        method: 'POST',
        body: JSON.stringify({ ...getInputs(), refreshToken, userEmail }),
      });
      log('\u2705 Pair saved', out);
    }
    await loadPairs();
  } catch (e) {
    log('\u274c Save error: ' + e.message);
    alert(e.message);
  }
}

async function syncNow() {
  const ok = await showConfirm({
    icon: '\u26a0\ufe0f',
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
    log('\u2705 Sync result', out);
    sendNotif('SHD Sync', 'Manual sync completed');
    await loadPairs();
  } catch (e) {
    log('\u274c Sync error: ' + e.message);
    sendNotif('SHD Sync', 'Sync failed: ' + e.message);
    alert(e.message);
  }
}

async function syncAllPairs() {
  if (!state.lastPairs.length) { log('No pairs to sync'); return; }

  const ok = await showConfirm({
    icon: '\ud83d\udd04',
    title: 'Sync All ' + state.lastPairs.length + ' Pairs',
    desc: 'จะทำ <b>Full-replace</b> ทุก pair<br>ข้อมูลปลายทางทั้งหมดจะถูกลบแล้ว sync ใหม่',
    confirmText: 'Sync All',
    confirmClass: 'primary',
  });
  if (!ok) return;

  await runBatchSync('manual');
}

async function syncAllPairsAuto() {
  if (!state.lastPairs.length) return;
  await runBatchSync('auto');
}

async function runBatchSync(source) {
  const total = state.lastPairs.length;
  log((source === 'auto' ? '\ud83d\udd04 Auto-syncing ' : '\ud83d\udd04 Syncing all ') + total + ' pairs...');

  state.syncedCount = 0;
  let failCount = 0;
  showProgress(0, total, source === 'auto' ? 'Auto-syncing...' : 'Starting...');

  for (let i = 0; i < total; i++) {
    showProgress(i, total, `Syncing ${i + 1}/${total}...`);
    const before = state.syncedCount;
    await syncOnePair(state.lastPairs[i]);
    if (state.syncedCount === before) failCount++;
  }

  showProgress(total, total, 'Done!');
  setTimeout(hideProgress, 2000);

  state.lastSyncTime = new Date();
  state.lastSyncOk   = state.syncedCount;
  state.lastSyncFail = failCount;
  updateSyncSummary();

  const msg = (source === 'auto' ? 'Auto-sync done. ' : 'All pairs synced. ') + 'OK: ' + state.syncedCount + '/' + total;
  log('\u2705 ' + msg);
  sendNotif('SHD Sync', msg);
}

async function syncOnePair(pair) {
  const { refreshToken, userEmail } = state;
  setPairStatus(pair.rowId, 'syncing', '<span class="spin">\u21bb</span> Syncing\u2026');
  markCard(pair.rowId, 'syncing');
  try {
    const out = await fetchJson('/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        pairs: [{ ...pair, refreshToken, userEmail: pair.user || userEmail, source: 'auto', forceNew: true }],
      }),
    });
    const r = out.results?.[0];
    const rows = r?.rowCount ?? '?';
    setPairStatus(pair.rowId, 'success', '\u2705 ' + rows + ' rows \u00b7 ' + new Date().toLocaleTimeString());
    markCard(pair.rowId, 'success');
    state.syncedCount++;
    const tag = pair.sheetUrl.split('/d/')[1]?.slice(0, 12) || pair.sheetId;
    log('\u2705 [' + tag + '] ' + rows + ' rows');
    updatePairMeta(pair.rowId, new Date().toISOString());
  } catch (e) {
    setPairStatus(pair.rowId, 'error', '\u274c ' + e.message);
    markCard(pair.rowId, 'error');
    log('\u274c Pair error [rowId=' + pair.rowId + ']: ' + e.message);
  }
}

function setPairStatus(rowId, cls, text) {
  const el = document.querySelector('[data-status="' + rowId + '"]');
  if (!el) return;
  el.className = 'pair-status ' + cls;
  el.innerHTML = text;
}

function markCard(rowId, cls) {
  const card = document.querySelector('[data-card="' + rowId + '"]');
  if (!card) return;
  card.className = 'pair-card ' + cls;
  setTimeout(() => { if (card.className.includes(cls)) card.className = 'pair-card'; }, 4000);
}

function updatePairMeta(rowId, ts) {
  const el = document.querySelector('[data-lastsync="' + rowId + '"]');
  if (el) el.textContent = new Date(ts).toLocaleString('th-TH');
}

// ──────────────────────────────────────────────────
// Pair list rendering
// ──────────────────────────────────────────────────
async function loadPairs() {
  log('Loading pairs...');
  try {
    const out = await fetchJson('/api/pairs', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    state.lastPairs = out.pairs || [];
    $('pairCount').textContent = state.lastPairs.length + ' pairs';
    $('searchBar').style.display = state.lastPairs.length > 2 ? 'block' : 'none';

    if (!state.lastPairs.length) {
      $('pairsList').innerHTML = '<div class="empty-state"><div class="empty-icon">\ud83d\udced</div>\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e21\u0e35 pair</div>';
    } else {
      renderPairs(state.lastPairs);
    }
    log('\u2705 Loaded ' + state.lastPairs.length + ' pairs');
  } catch (e) {
    log('\u274c Load pairs error: ' + e.message);
  }
}

function pairCardHtml(p) {
  const dirTag = DIRECTION_LABELS[p.direction] || p.direction;
  const sourceLabel = isLarkSourceMode(p.direction) ? 'Lark Sheet' : 'Sheet';
  const lastSync = p.lastSyncAt ? new Date(p.lastSyncAt).toLocaleString('th-TH') : '\u2014';
  const search = escHtml((p.sheetUrl + ' ' + p.larkUrl + ' ' + p.direction).toLowerCase());
  return `
    <div class="pair-card" data-card="${p.rowId}" data-search="${search}">
      <div class="pair-dir-tag">${dirTag}</div>
      <div class="pair-info"><b>${sourceLabel}:</b> ${escHtml(p.sheetUrl)}</div>
      <div class="pair-info"><b>Lark Base:</b> ${escHtml(p.larkUrl)}</div>
      <div class="pair-info"><b>Last:</b> <span data-lastsync="${p.rowId}">${lastSync}</span></div>
      <div class="pair-status idle" data-status="${p.rowId}">\u25cf Idle</div>
      <div class="pair-btns">
        <button class="primary" data-sync="${p.rowId}">\u26a1 Sync</button>
        <button class="warn-btn" data-edit="${p.rowId}">\u270e Edit</button>
        <button class="danger" data-deact="${p.rowId}">\u2715 Deactivate</button>
      </div>
    </div>
  `;
}

function bindPairButtons() {
  document.querySelectorAll('[data-sync]').forEach(btn => {
    btn.onclick = async () => {
      const pair = state.lastPairs.find(x => String(x.rowId) === btn.dataset.sync);
      if (!pair) return;
      const ok = await showConfirm({
        icon: '\u26a1',
        title: 'Sync Pair',
        desc: 'Full-replace sync<br>ข้อมูล<b>ปลายทางจะถูกลบทั้งหมด</b>แล้ว sync ใหม่',
        confirmText: 'Sync',
        confirmClass: 'primary',
      });
      if (ok) await syncOnePair(pair);
    };
  });
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.onclick = () => {
      const pair = state.lastPairs.find(x => String(x.rowId) === btn.dataset.edit);
      if (pair) startEdit(pair);
    };
  });
  document.querySelectorAll('[data-deact]').forEach(btn => {
    btn.onclick = async () => {
      const ok = await showConfirm({
        icon: '\ud83d\uddd1\ufe0f',
        title: 'Deactivate Pair',
        desc: 'Pair นี้จะถูกปิดการใช้งาน<br>สามารถสร้างใหม่ได้ภายหลัง',
        confirmText: 'Deactivate',
        confirmClass: 'danger',
      });
      if (!ok) return;
      await fetchJson('/api/pairs', {
        method: 'PUT',
        body: JSON.stringify({ refreshToken: state.refreshToken, rowId: btn.dataset.deact, active: false }),
      });
      await loadPairs();
    };
  });
}

function renderPairs(pairs) {
  $('pairsList').innerHTML = pairs.map(pairCardHtml).join('');
  bindPairButtons();
}

function filterPairs() {
  const q = $('searchInput').value.toLowerCase().trim();
  document.querySelectorAll('.pair-card[data-search]').forEach(card => {
    card.classList.toggle('hidden', q !== '' && !card.dataset.search.includes(q));
  });
}

// ──────────────────────────────────────────────────
// Auto-sync
// ──────────────────────────────────────────────────
function startAutoSync() {
  stopAutoSync();
  $('autoBar').style.display      = 'flex';
  $('autoStartRow').style.display = 'none';
  scheduleNextAutoSync();
  log('\ud83d\udd04 Auto-sync started');
  updateInfoRow();
}

function stopAutoSync() {
  clearTimeout(state.autoTimer);
  clearInterval(state.cdTimer);
  state.autoTimer = null;
  $('autoBar').style.display      = 'none';
  $('autoStartRow').style.display = state.refreshToken ? 'block' : 'none';
  $('autoCd').textContent = '\u2014';
  updateInfoRow();
}

function scheduleNextAutoSync() {
  const secs = parseInt($('autoInterval').value, 10);
  state.autoSecondsLeft = secs;
  $('autoCd').textContent = fmtTime(state.autoSecondsLeft);
  clearInterval(state.cdTimer);
  state.cdTimer = setInterval(() => {
    state.autoSecondsLeft--;
    $('autoCd').textContent = fmtTime(Math.max(0, state.autoSecondsLeft));
  }, 1000);
  state.autoTimer = setTimeout(async () => {
    clearInterval(state.cdTimer);
    if (!state.lastPairs.length) await loadPairs();
    await syncAllPairsAuto();
    scheduleNextAutoSync();
  }, secs * 1000);
}

function restartAutoIfRunning() {
  if (state.autoTimer) { stopAutoSync(); startAutoSync(); }
}

// ──────────────────────────────────────────────────
// How-to toggle
// ──────────────────────────────────────────────────
function toggleHowto() {
  const body = $('howtoBody');
  const btn  = $('howtoToggleBtn');
  const collapsed = body.classList.toggle('collapsed');
  btn.textContent = collapsed ? '\u25bc \u0e02\u0e22\u0e32\u0e22' : '\u25b2 \u0e22\u0e48\u0e2d';
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
  $('log').textContent = '\u2014 ready \u2014';
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
    $('cronUrl').textContent   = location.origin + '/api/sync';
    $('cronUrl2').textContent  = location.origin + '/api/sync';
    log('Config loaded', cfg);
  } catch (e) {
    log('Config error: ' + e.message);
  }

  if (state.refreshToken && state.userEmail) {
    setAuthed(true);
    await loadPairs();
    startAutoSync();
  } else {
    updateInfoRow();
  }
}

function bindEvents() {
  $('btnTheme').onclick    = toggleTheme;
  $('btnLogin').onclick    = startLogin;
  $('btnLogout').onclick   = logout;
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.onclick = () => setMode(btn.dataset.mode);
  });
  $('btnCancelEdit').onclick = cancelEdit;
  $('btnSavePair').onclick = savePair;
  $('btnSyncNow').onclick  = syncNow;
  $('btnReload').onclick   = loadPairs;
  $('btnSyncAll').onclick  = syncAllPairs;
  $('btnStartAuto').onclick = startAutoSync;
  $('btnStopAuto').onclick  = stopAutoSync;
  $('autoInterval').onchange = restartAutoIfRunning;
  $('searchInput').oninput   = filterPairs;
  $('btnClearLog').onclick   = clearLogs;
  $('btnExportLog').onclick  = exportLogs;
  $('howtoSection').querySelector('.howto-hd').onclick = toggleHowto;
  $('howtoToggleBtn').onclick = (ev) => { ev.stopPropagation(); toggleHowto(); };

  window.addEventListener('message', onOauthMessage);
}

applyTheme(localStorage.getItem('shd_theme') || 'light');
bindEvents();
bootstrap();
