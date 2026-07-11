// ════════════════════════════════════════════════════
// SHD Sync — Frontend
// ════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

// ──────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────
const CONFIG = { historySheetId: null, allowedDomain: null, adminEmails: [], localTest: false };

const state = {
  refreshToken: localStorage.getItem('google_refresh_token') || '',
  userEmail:    localStorage.getItem('google_user_email')    || '',
  masterMode:   'lark-to-sheet',
  sourceColumns:   [],   // last scanned header names for the current source
  selectedColumns: [],   // chosen subset; empty = all columns
  filterFields:    [],   // scanned dropdown fields: [{name, multi, options[]}]
  filters:         [],   // chosen value filters: [{field, values[]}]; empty = all rows
  editingRowId:    null, // when set, Save Auto-sync updates this pair instead of creating one
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
// keepOpenOnConfirm: leave the modal visible after the user confirms, so a
// follow-up busy/result state can swap its content WITHOUT replaying the
// open animation (prevents the popup "bouncing twice").
function showConfirm({ iconName, title, desc, confirmText, confirmClass, keepOpenOnConfirm }) {
  return new Promise(resolve => {
    $('modalIcon').innerHTML    = icon(iconName || 'alertTriangle', 40);
    $('modalTitle').textContent = title || 'Confirm';
    $('modalDesc').innerHTML    = desc || '';
    $('modalConfirm').textContent = confirmText || 'Confirm';
    $('modalConfirm').className   = confirmClass || 'danger';
    $('modalConfirm').style.display = '';
    $('modalCancel').style.display  = '';
    $('confirmModal').classList.add('show');

    const cleanup = (val) => {
      if (!(val && keepOpenOnConfirm)) $('confirmModal').classList.remove('show');
      $('modalConfirm').onclick = null;
      $('modalCancel').onclick  = null;
      resolve(val);
    };
    $('modalConfirm').onclick = () => cleanup(true);
    $('modalCancel').onclick  = () => cleanup(false);
  });
}

// Spinner state inside the same modal — no buttons, content swap only.
function showModalBusy({ title, desc }) {
  $('modalIcon').innerHTML      = `<span class="spin">${icon('refreshCw', 40)}</span>`;
  $('modalTitle').textContent   = title || 'กำลังทำงาน...';
  $('modalDesc').innerHTML      = desc || 'รอสักครู่';
  $('modalConfirm').style.display = 'none';
  $('modalCancel').style.display  = 'none';
  $('confirmModal').classList.add('show');
}

// Single-button info/success popup (reuses the confirm modal, hides Cancel).
// If the modal is already open (confirm/busy state), content swaps in place.
function showAlert({ iconName, title, desc, confirmText, confirmClass }) {
  return new Promise(resolve => {
    $('modalIcon').innerHTML      = icon(iconName || 'checkCircle', 40);
    $('modalTitle').textContent   = title || '';
    $('modalDesc').innerHTML      = desc || '';
    $('modalConfirm').textContent = confirmText || 'OK';
    $('modalConfirm').className   = confirmClass || 'primary';
    $('modalConfirm').style.display = '';
    $('modalCancel').style.display  = 'none';
    $('confirmModal').classList.add('show');

    const cleanup = () => {
      $('confirmModal').classList.remove('show');
      $('modalConfirm').onclick = null;
      $('modalCancel').style.display = '';   // restore for future confirms
      resolve(true);
    };
    $('modalConfirm').onclick = () => cleanup();
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
  $('syncMode').disabled        = !ok;
  $('syncInterval').disabled    = !ok;
  $('noHeader').disabled        = !ok;
  $('btnSyncNow').disabled      = !ok;
  $('btnSaveCron').disabled     = !ok;
  $('btnPickColumns').disabled  = !ok;

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
  updateTabVisibility();
  updateInfoRow();
}

function updateInfoRow() {
  // Info cards were removed — auth status now lives in the topbar chip only.
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
  // The expected URL kind changed — clear any red validation marks.
  markInvalid('sheetUrl', false);
  markInvalid('larkUrl', false);
  // Columns depend on the source, which changes with the direction — clear any
  // prior selection so a stale pick can't leak into a different source.
  clearColumnSelection();
  updateInfoRow();
}

// ──────────────────────────────────────────────────
// Column picker
// ──────────────────────────────────────────────────
function clearColumnSelection() {
  state.sourceColumns = [];
  state.selectedColumns = [];
  state.filterFields = [];
  state.filters = [];
  const fb = $('btnFilter'); if (fb) fb.disabled = true;
  updateColumnsHint();
  updateFilterHint();
}

function updateColumnsHint() {
  const hint = $('columnsHint');
  const btn = $('btnPickColumns');
  if (!hint || !btn) return;
  const n = state.selectedColumns.length;
  if (n === 0) {
    hint.textContent = 'ยังไม่ได้เลือก = ซิงค์ทุกคอลัมน์';
    btn.innerHTML = `${icon('link', 14)} สแกน & เลือกคอลัมน์`;
  } else {
    const total = state.sourceColumns.length || n;
    hint.innerHTML = `ซิงค์ <b style="color:var(--accent)">${n}</b> จาก ${total} คอลัมน์`;
    btn.innerHTML = `${icon('link', 14)} เลือกคอลัมน์ (${n}/${total})`;
  }
}

// Scan the source columns for the current inputs, then open the picker.
async function scanColumns() {
  let inputs;
  try {
    inputs = getInputs();   // needs both URLs; also gives direction
  } catch (e) {
    await showAlert({ iconName: 'xCircle', title: 'ใส่ลิงก์ก่อน', desc: escHtml(e.message), confirmClass: 'danger' });
    return;
  }
  const btn = $('btnPickColumns');
  btn.disabled = true;
  const prev = btn.innerHTML;
  btn.innerHTML = `<span class="spin">${icon('refreshCw', 14)}</span> กำลังสแกน...`;
  try {
    log('Scanning source columns...');
    const out = await fetchJson('/api/columns', {
      method: 'POST',
      body: JSON.stringify({
        refreshToken: state.refreshToken,
        direction: inputs.direction,
        sheetUrl: inputs.sheetUrl,
        larkUrl: inputs.larkUrl,
      }),
    });
    const headers = out.headers || [];
    if (headers.length === 0) throw new Error('ไม่พบคอลัมน์ในต้นทาง');
    state.sourceColumns = headers;
    // Dropdown fields available for value filtering (Lark Base sources only).
    state.filterFields = out.filterFields || [];
    const fb = $('btnFilter');
    if (fb) fb.disabled = state.filterFields.length === 0;
    log(`[OK] สแกนเจอ ${headers.length} คอลัมน์` + (state.filterFields.length ? ` · กรองได้ ${state.filterFields.length} ฟิลด์` : ''));
    updateFilterHint();
    openColModal();
  } catch (e) {
    log('[ERR] Scan columns: ' + e.message);
    await showAlert({
      iconName: 'xCircle',
      title: 'สแกนคอลัมน์ไม่สำเร็จ',
      desc: escHtml(e.message) + '<br><span style="color:var(--muted)">ถ้าเป็น Lark: เช็คว่า Add app เข้าไฟล์แล้ว</span>',
      confirmClass: 'danger',
    });
  } finally {
    btn.disabled = false;
    if (btn.innerHTML.includes('spin')) btn.innerHTML = prev;
    updateColumnsHint();
  }
}

// While the modal is open, `_colWorking` (a Set) is the source of truth for what
// is ticked. It survives search filtering, and is collapsed to selectedColumns
// (or [] when everything is ticked) only on Apply.
let _colWorking = new Set();

function renderColList(filter = '') {
  const list = $('colList');
  const f = filter.trim().toLowerCase();
  list.innerHTML = '';
  let shown = 0;
  state.sourceColumns.forEach((name, idx) => {
    if (f && !name.toLowerCase().includes(f)) return;
    shown++;
    const on = _colWorking.has(name);
    const row = document.createElement('label');
    row.className = 'opt' + (on ? ' on' : '');
    row.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>
      <span class="opt-idx">${idx + 1}</span>
      <span class="opt-name">${escHtml(name)}</span>`;
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) _colWorking.add(name); else _colWorking.delete(name);
      row.classList.toggle('on', cb.checked);
      updateColCount();
    });
    list.appendChild(row);
  });
  if (shown === 0) list.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;text-align:center">ไม่พบคอลัมน์ที่ค้นหา</div>';
  updateColCount();
}

function updateColCount() {
  $('colCount').textContent = `เลือก ${_colWorking.size} / ${state.sourceColumns.length}`;
}

function openColModal() {
  // Empty selection means "all" — start with everything ticked.
  _colWorking = new Set(state.selectedColumns.length ? state.selectedColumns : state.sourceColumns);
  $('colSubtitle').textContent = `พบ ${state.sourceColumns.length} คอลัมน์ในต้นทาง — ติ๊กเฉพาะที่ต้องการซิงค์`;
  $('colSearch').value = '';
  renderColList('');
  $('colModal').classList.add('show');
}

function closeColModal() {
  $('colModal').classList.remove('show');
}

function applyColSelection() {
  // Keep source order; store [] (= all) when everything is ticked.
  const picked = state.sourceColumns.filter(n => _colWorking.has(n));
  state.selectedColumns = picked.length === state.sourceColumns.length ? [] : picked;
  closeColModal();
  updateColumnsHint();
  log(state.selectedColumns.length
    ? `เลือก ${state.selectedColumns.length} คอลัมน์`
    : 'เลือกทุกคอลัมน์');
}

// ──────────────────────────────────────────────────
// Value filter (row filter by dropdown value)
// ──────────────────────────────────────────────────
// While the modal is open, `_filterWorking` maps fieldName → Set(values).
let _filterWorking = new Map();

function updateFilterHint() {
  const hint = $('filterHint');
  const btn = $('btnFilter');
  if (!hint) return;
  const n = state.filters.length;
  if (n === 0) {
    hint.textContent = state.filterFields.length
      ? 'ไม่กรอง = เอาทุกแถว (กดเพื่อเลือกค่า)'
      : 'สแกนก่อน แล้วเลือกค่าที่ต้องการ · ไม่กรอง = เอาทุกแถว';
    if (btn) btn.innerHTML = `${icon('shuffle', 14)} ตั้งตัวกรองข้อมูล`;
  } else {
    const parts = state.filters.map(f => `${f.field} (${f.values.length})`);
    hint.innerHTML = `กรอง: <b style="color:var(--accent)">${escHtml(parts.join(' · '))}</b>`;
    if (btn) btn.innerHTML = `${icon('shuffle', 14)} ตัวกรอง (${n} ฟิลด์)`;
  }
}

function openFilterModal() {
  _filterWorking = new Map();
  for (const f of state.filters) _filterWorking.set(f.field, new Set(f.values));
  renderFilterFields();
  $('filterModal').classList.add('show');
}

function closeFilterModal() {
  $('filterModal').classList.remove('show');
}

function renderFilterFields() {
  const wrap = $('filterFields');
  wrap.innerHTML = '';
  if (state.filterFields.length === 0) {
    wrap.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px">ต้นทางนี้ไม่มีฟิลด์แบบ Dropdown ให้กรอง</div>';
    return;
  }
  state.filterFields.forEach((f) => {
    const picked = _filterWorking.get(f.name) || new Set();
    const field = document.createElement('div');
    field.className = 'filter-field';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'filter-field-head';
    head.innerHTML = `<span class="filter-caret">${icon('chevronDown', 14)}</span>
      <span>${escHtml(f.name)}</span>${f.multi ? '<span style="font-size:10px;color:var(--muted);font-weight:500">(หลายค่า)</span>' : ''}
      <span class="filter-badge ${picked.size ? 'on' : ''}">${picked.size ? picked.size + ' เลือก' : f.options.length + ' ค่า'}</span>`;
    const opts = document.createElement('div');
    opts.className = 'filter-opts';
    opts.style.display = 'none';
    f.options.forEach(val => {
      const on = picked.has(val);
      const label = document.createElement('label');
      label.className = 'opt' + (on ? ' on' : '');
      label.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span class="opt-name">${escHtml(val)}</span>`;
      const cb = label.querySelector('input');
      cb.addEventListener('change', () => {
        let set = _filterWorking.get(f.name);
        if (!set) { set = new Set(); _filterWorking.set(f.name, set); }
        if (cb.checked) set.add(val); else set.delete(val);
        if (set.size === 0) _filterWorking.delete(f.name);
        label.classList.toggle('on', cb.checked);
        const s2 = _filterWorking.get(f.name) || new Set();
        const badge = head.querySelector('.filter-badge');
        badge.textContent = s2.size ? s2.size + ' เลือก' : f.options.length + ' ค่า';
        badge.classList.toggle('on', s2.size > 0);
      });
      opts.appendChild(label);
    });
    head.onclick = () => {
      const open = field.classList.toggle('open');
      opts.style.display = open ? 'block' : 'none';
    };
    field.appendChild(head);
    field.appendChild(opts);
    wrap.appendChild(field);
  });
}

function applyFilters() {
  state.filters = [];
  for (const [field, set] of _filterWorking.entries()) {
    if (set.size) state.filters.push({ field, values: [...set] });
  }
  closeFilterModal();
  updateFilterHint();
  log(state.filters.length ? `ตั้งตัวกรอง ${state.filters.length} ฟิลด์` : 'ไม่กรอง (ทุกแถว)');
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
// URL parsers (mirror api/_lib/urls.js) for client-side validation.
function _gSheetId(u) { return (String(u).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || ''; }
function _larkSheetTok(u) { const s = String(u); return (s.match(/\/wiki\/([a-zA-Z0-9]+)/) || [])[1] || (s.match(/\/sheets\/([a-zA-Z0-9]+)/) || [])[1] || ''; }
function _larkBase(u) { const s = String(u); return { baseId: (s.match(/\/base\/([a-zA-Z0-9]+)/) || [])[1] || '', tableId: (s.match(/[?&]table=([a-zA-Z0-9]+)/) || [])[1] || '' }; }
function validateSideClient(kind, url) {
  if (kind === 'google'    && !_gSheetId(url))     return 'ต้องเป็นลิงก์ Google Sheet (docs.google.com/spreadsheets/…)';
  if (kind === 'larkSheet' && !_larkSheetTok(url)) return 'ต้องเป็นลิงก์ Lark Sheet (/wiki/… หรือ /sheets/…)';
  if (kind === 'larkBase') { const { baseId, tableId } = _larkBase(url); if (!baseId || !tableId) return 'ต้องเป็นลิงก์ Lark Base (/base/<id>?table=<id>)'; }
  return null;
}
function markInvalid(id, on) { $(id).classList.toggle('invalid', !!on); }

function getInputs() {
  const s = $('sheetUrl').value.trim();
  const l = $('larkUrl').value.trim();
  const kinds = FIELD_KINDS[state.masterMode];
  markInvalid('sheetUrl', false);
  markInvalid('larkUrl', false);
  if (!s) { markInvalid('sheetUrl', true); throw new Error(`กรุณาใส่ลิงก์ช่องบน (${URL_KIND[kinds.top].label})`); }
  if (!l) { markInvalid('larkUrl', true); throw new Error(`กรุณาใส่ลิงก์ช่องล่าง (${URL_KIND[kinds.bottom].label})`); }
  const e1 = validateSideClient(kinds.top, s);
  if (e1) { markInvalid('sheetUrl', true); throw new Error('ช่องบน — ' + e1); }
  const e2 = validateSideClient(kinds.bottom, l);
  if (e2) { markInvalid('larkUrl', true); throw new Error('ช่องล่าง — ' + e2); }
  const syncMode = $('syncMode').value === 'append' ? 'append' : 'replace';
  return {
    sheetUrl: s, larkUrl: l, direction: state.masterMode,
    syncMode,
    columns: state.selectedColumns,   // [] = all columns
    filters: state.filters,           // [] = all rows
    noHeader: $('noHeader').checked,  // treat row 1 as data (sheet sources)
  };
}

function resetForm() {
  $('sheetUrl').value = '';
  $('larkUrl').value  = '';
  $('syncMode').value = 'replace';
  $('noHeader').checked = false;
  setIntervalControl(60);
  setMode('lark-to-sheet');   // also clears the column selection
  state.editingRowId = null;  // cancel any in-progress edit
  updateEditUI();
  log('Form reset');
}

async function syncNow() {
  let inputs;
  try {
    inputs = getInputs();
  } catch (e) {
    await showAlert({ iconName: 'xCircle', title: 'ข้อมูลไม่ถูกต้อง', desc: escHtml(e.message), confirmClass: 'danger' });
    return;
  }
  const isAppend = $('syncMode').value === 'append';
  const ok = await showConfirm({
    iconName: 'alertTriangle',
    title: isAppend ? 'Append Sync' : 'Full-replace Sync',
    desc: isAppend
      ? 'จะ <b>เพิ่มข้อมูลต่อท้าย</b>ข้อมูลที่มีอยู่<br>ไม่ลบของเดิม ต้องการดำเนินการ?'
      : 'ข้อมูล<b>ปลายทางจะถูกลบทั้งหมด</b>แล้ว sync ใหม่<br>ต้องการดำเนินการ?',
    confirmText: 'Sync Now',
    confirmClass: 'primary',
    keepOpenOnConfirm: true,   // morph into busy → result without re-animating
  });
  if (!ok) return;
  $('btnSyncNow').disabled = true;
  $('btnSaveCron').disabled = true;
  showModalBusy({ title: 'กำลังซิงค์...', desc: 'กำลังโอนข้อมูล รอสักครู่' });
  try {
    const { refreshToken, userEmail } = state;
    log('Manual sync...');
    const out = await fetchJson('/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        pairs: [{ ...inputs, refreshToken, userEmail, source: 'manual', forceNew: true }],
      }),
    });
    log('[OK] Sync result', out);
    const r = (out.results || [])[0] || {};
    if (r.status === 'error') {
      sendNotif('SHD Sync', 'Sync failed: ' + (r.error || 'error'));
      await showAlert({
        iconName: 'xCircle',
        title: 'ซิงค์ไม่สำเร็จ',
        desc: escHtml(r.error || 'เกิดข้อผิดพลาด'),
        confirmClass: 'danger',
      });
    } else {
      sendNotif('SHD Sync', 'Manual sync completed');
      await showAlert({
        iconName: 'checkCircle',
        title: 'ซิงค์เสร็จแล้ว ✓',
        desc: `ซิงค์ข้อมูลเรียบร้อย <b style="color:var(--green)">${r.rowCount ?? 0}</b> แถว`,
        confirmClass: 'primary',
      });
    }
  } catch (e) {
    log('[ERR] Sync error: ' + e.message);
    sendNotif('SHD Sync', 'Sync failed: ' + e.message);
    await showAlert({
      iconName: 'xCircle',
      title: 'ซิงค์ไม่สำเร็จ',
      desc: escHtml(e.message),
      confirmClass: 'danger',
    });
  } finally {
    $('btnSyncNow').disabled = false;
    $('btnSaveCron').disabled = false;
  }
}

// ──────────────────────────────────────────────────
// Cron Manager (auto-sync schedules)
// ──────────────────────────────────────────────────
const INTERVAL_LABELS = {
  1: 'ทุก 1 นาที', 3: 'ทุก 3 นาที', 5: 'ทุก 5 นาที', 15: 'ทุก 15 นาที', 30: 'ทุก 30 นาที', 60: 'ทุก 1 ชม.',
  120: 'ทุก 2 ชม.', 360: 'ทุก 6 ชม.', 720: 'ทุก 12 ชม.',
  1440: 'ทุก 1 วัน', 4320: 'ทุก 3 วัน', 10080: 'ทุก 7 วัน', 21600: 'ทุก 15 วัน', 43200: 'ทุก 30 วัน',
};

// Effective interval from the control (dropdown preset, or "custom" typed value).
function getIntervalMin() {
  const sel = $('syncInterval');
  if (sel.value === 'custom') {
    const n = parseInt($('syncIntervalCustom').value, 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 525600) : 60;
  }
  return parseInt(sel.value, 10) || 60;
}
function onIntervalChange() {
  const custom = $('syncInterval').value === 'custom';
  const box = $('syncIntervalCustom');
  box.style.display = custom ? '' : 'none';
  box.disabled = !custom;
  if (custom) box.focus();
}
// Set the control to a value: pick a matching preset, else switch to "custom".
function setIntervalControl(min) {
  const sel = $('syncInterval');
  const box = $('syncIntervalCustom');
  const opt = [...sel.options].find(o => o.value === String(min));
  if (opt) { sel.value = String(min); box.style.display = 'none'; box.disabled = true; }
  else { sel.value = 'custom'; box.value = String(min); box.style.display = ''; box.disabled = false; }
}

// Short labels for the URL rows in the Cron Manager, derived from what each
// field actually holds for the pair's direction (see FIELD_KINDS).
const KIND_SHORT = { google: 'Google Sheet', larkSheet: 'Lark Sheet', larkBase: 'Lark Base' };

let cronPairs = [];

const TH_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  // e.g. "10 ก.ค. 2026, 18:20" — full Gregorian year, 24h, no confusing 2-digit BE.
  return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Relative time, e.g. "เมื่อ 5 นาทีที่แล้ว".
function relTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'อีกสักครู่';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'เมื่อสักครู่';
  if (min < 60) return `เมื่อ ${min} นาทีที่แล้ว`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `เมื่อ ${hr} ชม.ที่แล้ว`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `เมื่อ ${day} วันที่แล้ว`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `เมื่อ ${mon} เดือนที่แล้ว`;
  return `เมื่อ ${Math.floor(mon / 12)} ปีที่แล้ว`;
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

const CRON_EMPTY_DEFAULT =
  'ยังไม่มีงาน auto-sync — กรอกลิงก์ในแท็บ Sync เลือกช่วงเวลา แล้วกด <b>Save Auto-sync</b>';

function renderPairsMessage(msg) {
  $('cronList').innerHTML = '';
  const empty = $('cronEmpty');
  empty.style.display = '';
  empty.innerHTML = msg;
}

async function loadPairs() {
  if (!state.refreshToken) {
    renderPairsMessage('ยังไม่ได้เข้าสู่ระบบ — กดปุ่ม <b>Login</b> มุมขวาบนก่อน');
    return;
  }
  try {
    const out = await fetchJson('/api/pairs', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: state.refreshToken }),
    });
    cronPairs = out.pairs || [];
    log(`[OK] โหลด auto-sync ${cronPairs.length} รายการ`);
    renderPairs(cronPairs);
  } catch (e) {
    log('[ERR] Load auto-sync list: ' + e.message);
    renderPairsMessage(
      'โหลดรายการไม่สำเร็จ: ' + escHtml(e.message) +
      '<br><span style="color:var(--muted)">ลอง Logout แล้ว Login ใหม่ (token อาจหมดอายุ)</span>'
    );
  }
}

function renderPairs(pairs) {
  const list = $('cronList');
  const empty = $('cronEmpty');
  list.innerHTML = '';
  if (!pairs || pairs.length === 0) {
    empty.style.display = '';
    empty.innerHTML = CRON_EMPTY_DEFAULT;
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
          <button class="cron-tag cron-mode ${p.syncMode === 'append' ? 'info' : 'warn'}" data-act="mode" data-row="${p.rowId}" title="กดเพื่อสลับโหมด Replace ⇄ Append">${p.syncMode === 'append' ? 'Append' : 'Replace'}</button>
          ${(p.columns && p.columns.length) ? `<span class="cron-tag" title="${escHtml(p.columns.join(', '))}">${icon('link', 11)} ${p.columns.length} คอลัมน์</span>` : ''}
          ${(p.filters && p.filters.length) ? `<span class="cron-tag" title="${escHtml(p.filters.map(f => f.field + '=' + f.values.join('/')).join(' · '))}">${icon('shuffle', 11)} กรอง ${p.filters.length}</span>` : ''}
          <span class="cron-sub">ซิงค์ล่าสุด: ${p.lastSyncAt ? escHtml(fmtTime(p.lastSyncAt)) + ' <span style="opacity:.65">(' + escHtml(relTime(p.lastSyncAt)) + ')</span>' : '<span style="opacity:.7">ยังไม่เคยซิงค์</span>'} · ${escHtml(nextRunLabel(p))}</span>
        </div>
        <div class="cron-meta">
          <span class="cron-owner">${icon('user', 12)} ${escHtml(p.user || 'ไม่ระบุ')}</span>
          <span class="cron-sub">สร้างเมื่อ: ${fmtTime(p.createdAt)}</span>
        </div>
        <div class="cron-urls">
          <div><span class="cron-url-label">${KIND_SHORT[(FIELD_KINDS[p.direction] || {}).top] || 'ต้นทาง'}:</span> ${escHtml(p.sheetUrl)}</div>
          <div><span class="cron-url-label">${KIND_SHORT[(FIELD_KINDS[p.direction] || {}).bottom] || 'ปลายทาง'}:</span> ${escHtml(p.larkUrl)}</div>
        </div>
        <div class="cron-cf">
          <div><span class="cron-cf-label">${icon('link', 11)} คอลัมน์:</span> ${(p.columns && p.columns.length) ? `<b>${escHtml(p.columns.length)}</b> — ${escHtml(p.columns.join(' · '))}` : 'ทุกคอลัมน์'}</div>
          <div><span class="cron-cf-label">${icon('shuffle', 11)} ตัวกรอง:</span> ${(p.filters && p.filters.length) ? p.filters.map(f => `${escHtml(f.field)} = <b>${escHtml(f.values.join(', '))}</b>`).join('  ·  ') : 'ไม่กรอง (ทุกแถว)'}</div>
          ${p.noHeader ? `<div><span class="cron-cf-label">${icon('bookOpen', 11)} หัวคอลัมน์:</span> <b>แถวแรกไม่มีหัวคอลัมน์</b> — ซิงค์ทุกแถว (ตั้งชื่อ Column 1..N)</div>` : ''}
        </div>
      </div>
      <div class="cron-actions">
        <button class="cron-run" data-act="edit" data-row="${p.rowId}" title="แก้ไขงานนี้">${icon('pencil', 13)} แก้ไข</button>
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
      else if (act === 'mode') changeSyncMode(rowId);
      else if (act === 'edit') editPair(rowId);
      else if (act === 'run') runPairNow(rowId, btn);
      else if (act === 'del') deletePair(rowId);
    };
  });
}

// Reflect edit mode in the Save button + show a cancel hint.
function updateEditUI() {
  const btn = $('btnSaveCron');
  if (state.editingRowId) {
    btn.innerHTML = `${icon('save', 14)} อัปเดต Auto-sync`;
  } else {
    btn.innerHTML = `${icon('clock', 14)} Save Auto-sync`;
  }
}

// Load a saved pair back into the Sync form for editing.
function editPair(rowId) {
  const p = cronPairs.find(x => x.rowId === rowId);
  if (!p) return;
  setMode(p.direction);                 // relabels + clears column/filter selection first
  $('sheetUrl').value = p.sheetUrl || '';
  $('larkUrl').value  = p.larkUrl || '';
  $('syncMode').value = p.syncMode === 'append' ? 'append' : 'replace';
  $('noHeader').checked = !!p.noHeader;
  setIntervalControl(p.intervalMin || 60);
  // Preserve the saved column/filter choices (source list needs a re-scan to change them).
  state.selectedColumns = Array.isArray(p.columns) ? p.columns.slice() : [];
  state.filters = Array.isArray(p.filters) ? p.filters.map(f => ({ field: f.field, values: f.values.slice() })) : [];
  updateColumnsHint();
  updateFilterHint();
  state.editingRowId = rowId;
  updateEditUI();
  switchTab('sync');
  log(`แก้ไข auto-sync #${rowId} — ปรับค่าแล้วกด "อัปเดต Auto-sync"`);
}

async function saveCron() {
  let inputs;
  try {
    inputs = getInputs();
  } catch (e) {
    await showAlert({ iconName: 'xCircle', title: 'ข้อมูลไม่ครบ', desc: escHtml(e.message), confirmClass: 'danger' });
    return;
  }
  const editing = state.editingRowId;
  $('btnSyncNow').disabled = true;
  $('btnSaveCron').disabled = true;
  showModalBusy({ title: editing ? 'กำลังอัปเดต Auto-sync...' : 'กำลังบันทึก Auto-sync...', desc: 'รอสักครู่' });
  try {
    const intervalMin = getIntervalMin();
    const { refreshToken, userEmail } = state;
    if (editing) {
      await fetchJson('/api/pairs', {
        method: 'PUT',
        body: JSON.stringify({ rowId: editing, ...inputs, intervalMin, refreshToken, userEmail }),
      });
      state.editingRowId = null;
      updateEditUI();
      log(`[OK] อัปเดต auto-sync #${editing}`);
    } else {
      await fetchJson('/api/pairs', {
        method: 'POST',
        body: JSON.stringify({ ...inputs, intervalMin, refreshToken, userEmail }),
      });
      log('[OK] Auto-sync saved');
    }
    sendNotif('SHD Sync', editing ? 'Auto-sync updated' : 'Auto-sync schedule saved');
    await loadPairs();
    const label = INTERVAL_LABELS[intervalMin] || (intervalMin + ' นาที');
    await showAlert({
      iconName: editing ? 'checkCircle' : 'clock',
      title: editing ? 'อัปเดตแล้ว ✓' : 'ตั้ง Auto-sync แล้ว ✓',
      desc: `ระบบจะซิงค์ให้อัตโนมัติ <b style="color:var(--accent)">${label}</b><br>ตลอด 24 ชม. — ดูได้ที่แท็บ Auto-sync`,
      confirmClass: 'primary',
    });
  } catch (e) {
    log('[ERR] Save auto-sync: ' + e.message);
    await showAlert({
      iconName: 'xCircle',
      title: 'บันทึกไม่สำเร็จ',
      desc: escHtml(e.message),
      confirmClass: 'danger',
    });
  } finally {
    $('btnSyncNow').disabled = false;
    $('btnSaveCron').disabled = false;
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

async function changeSyncMode(rowId) {
  const p = cronPairs.find(x => x.rowId === rowId);
  if (!p) return;
  const next = p.syncMode === 'append' ? 'replace' : 'append';
  const toReplace = next === 'replace';
  const ok = await showConfirm({
    iconName: toReplace ? 'refreshCw' : 'download',
    title: `สลับเป็นโหมด ${toReplace ? 'Replace' : 'Append'}`,
    desc: toReplace
      ? 'Replace = ลบข้อมูลปลายทางทั้งหมดแล้วเขียนใหม่ทั้งชุดทุกครั้ง — การแก้/เติมกลางตารางจะขึ้นครบ<br><b style="color:var(--red)">ระวัง:</b> ถ้าฝั่งปลายทางมีคนแก้ข้อมูลด้วยมือ จะถูกทับ'
      : 'Append = เพิ่มเฉพาะแถวใหม่ที่ท้ายตาราง ไม่ลบของเดิม<br><b>หมายเหตุ:</b> จะไม่ตามการแก้/เติมแถวเดิม',
    confirmText: `เปลี่ยนเป็น ${toReplace ? 'Replace' : 'Append'}`,
    confirmClass: toReplace ? 'danger' : 'primary',
  });
  if (!ok) return;
  try {
    await fetchJson('/api/pairs', {
      method: 'PUT',
      body: JSON.stringify({ rowId, syncMode: next, refreshToken: state.refreshToken }),
    });
    log(`[OK] เปลี่ยนโหมด #${rowId} → ${next}`);
    await loadPairs();
  } catch (e) {
    log('[ERR] Change mode: ' + e.message);
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
// Tab navigation (Auto-sync + Logs are admin-only)
// ──────────────────────────────────────────────────
function isAdmin() {
  return !!state.userEmail &&
    (CONFIG.adminEmails || []).includes(state.userEmail.toLowerCase());
}

// Slide the gradient capsule under the active tab.
function positionTabIndicator() {
  const ind = $('tabIndicator');
  const active = document.querySelector('#tabNav .tab.active');
  if (!ind || !active) return;
  ind.style.left  = active.offsetLeft + 'px';
  ind.style.width = active.offsetWidth + 'px';
}

function updateTabVisibility() {
  const admin = isAdmin();
  document.querySelectorAll('#tabNav .tab').forEach(btn => {
    if (btn.dataset.tab === 'sync') return;            // everyone sees Sync
    btn.style.display = admin ? '' : 'none';
  });
  // If a non-admin is somehow on a hidden tab, send them back to Sync.
  const activePanel = document.querySelector('.tab-panel.active');
  if (!admin && activePanel && activePanel.dataset.panel !== 'sync') {
    switchTab('sync');
  }
  requestAnimationFrame(positionTabIndicator);
}

function switchTab(name) {
  if (name !== 'sync' && !isAdmin()) name = 'sync';
  document.querySelectorAll('.tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.dataset.panel === name));
  positionTabIndicator();
  // Refresh the schedule list whenever the user opens the Auto-sync tab.
  if (name === 'cron' && state.refreshToken) loadPairs();
  if (name === 'history') loadHistory();
}

function bindTabs() {
  document.querySelectorAll('#tabNav .tab').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  window.addEventListener('resize', positionTabIndicator);
  // Re-measure once fonts/icons have finished loading (widths can shift).
  window.addEventListener('load', positionTabIndicator);
  requestAnimationFrame(positionTabIndicator);
}

// ──────────────────────────────────────────────────
// How-to toggle
// ──────────────────────────────────────────────────
// ──────────────────────────────────────────────────
// Logs export/clear
// ──────────────────────────────────────────────────
// ──────────────────────────────────────────────────
// Sync history (reads the shared History sheet)
// ──────────────────────────────────────────────────
async function loadHistory() {
  const empty = $('historyEmpty');
  const list = $('historyList');
  list.innerHTML = '';
  empty.style.display = '';
  empty.textContent = 'กำลังโหลดประวัติ…';
  try {
    const out = await fetchJson('/api/history');
    renderHistory(out.items || []);
  } catch (e) {
    list.innerHTML = '';
    empty.style.display = '';
    empty.textContent = 'โหลดประวัติไม่สำเร็จ: ' + e.message;
  }
}

// Destination URL of a sync (the file the data landed in), by direction.
function destUrlOf(it) {
  return (it.direction === 'lark-to-sheet' || it.direction === 'larkbase-to-larksheet') ? it.sheetUrl : it.larkUrl;
}
function acctColor(u) {
  const s = String(u || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}

function renderHistory(items) {
  const empty = $('historyEmpty');
  const list = $('historyList');
  list.innerHTML = '';
  if (!items.length) {
    empty.style.display = '';
    empty.textContent = 'ยังไม่มีประวัติการซิงค์';
    return;
  }
  empty.style.display = 'none';

  const head = `<div class="hist-row hist-head">
    <span></span><span>Account</span><span>เวลา</span><span>ทิศทาง</span><span class="hist-rows">แถว</span><span>สถานะ</span></div>`;

  const body = items.map(it => {
    const ok = String(it.status).toLowerCase() === 'success';
    const acct = it.user || '—';
    const dir = DIRECTION_LABELS[it.direction] || it.direction || '—';
    const badge = `<span class="badge ${ok ? 'ok' : 'no'}">${ok ? 'สำเร็จ' : 'ผิดพลาด'}</span>`;
    const isEmail = String(acct).includes('@');
    const acctCell = isEmail
      ? `<a class="hist-acct-email" href="mailto:${escHtml(acct)}" onclick="event.stopPropagation()" title="ส่งอีเมลถึง ${escHtml(acct)}">${escHtml(acct)}</a>`
      : `<span class="hist-acct-email" title="${escHtml(acct)}">${escHtml(acct)}</span>`;
    const dst = destUrlOf(it);
    const dirCell = dst
      ? `<a class="hist-dir" href="${escHtml(dst)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="เปิดปลายทาง: ${escHtml(dst)}">${escHtml(dir)} ↗</a>`
      : `<span class="hist-dir">${escHtml(dir)}</span>`;
    return `<div class="hist-item">
      <div class="hist-row hist-toggle">
        <span class="hist-caret2">${icon('chevronDown', 13)}</span>
        <span class="hist-acct">
          <span class="hist-avatar" style="background:${acctColor(acct)}">${escHtml(String(acct).charAt(0).toUpperCase())}</span>
          ${acctCell}
        </span>
        <span>${escHtml(fmtTime(it.time))}<div class="hist-rel">${escHtml(relTime(it.time))}</div></span>
        <span>${dirCell}</span>
        <span class="hist-rows">${escHtml(Number(it.rowCount || 0).toLocaleString())}</span>
        <span>${badge}</span>
      </div>
      <div class="hist-detail">
        <div class="hist-detail-grid">
          <div class="hd-full"><span class="hd-label">ต้นทาง</span> <a class="hd-link" href="${escHtml(it.sheetUrl)}" target="_blank" rel="noopener">${escHtml(it.sheetUrl || '—')}</a></div>
          <div class="hd-full"><span class="hd-label">ปลายทาง</span> <a class="hd-link" href="${escHtml(it.larkUrl)}" target="_blank" rel="noopener">${escHtml(it.larkUrl || '—')}</a></div>
          <div><span class="hd-label">ทิศทาง</span> ${escHtml(dir)}</div>
          <div><span class="hd-label">สถานะ</span> ${badge}</div>
          ${it.error ? `<div class="hd-full"><span class="hd-label">ข้อความผิดพลาด</span> <span class="hd-err">${escHtml(it.error)}</span></div>` : ''}
        </div>
        <div class="hist-detail-actions"><button class="hist-del-btn" data-hrow="${it.row}">${icon('trash', 12)} ลบรายการนี้</button></div>
      </div>
    </div>`;
  }).join('');

  list.innerHTML = `<div class="hist-table">${head}<div class="hist-body">${body}</div></div>`;

  // Click a row to expand/collapse its detail.
  list.querySelectorAll('.hist-toggle').forEach(row => {
    row.addEventListener('click', () => row.closest('.hist-item').classList.toggle('open'));
  });
  // Delete a single history entry.
  list.querySelectorAll('.hist-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteHistoryRow(parseInt(btn.dataset.hrow, 10)); });
  });
}

async function deleteHistoryRow(row) {
  if (!row) return;
  const ok = await showConfirm({
    iconName: 'trash', title: 'ลบรายการประวัตินี้?',
    desc: 'ลบออกจากประวัติถาวร (ไม่กระทบข้อมูลที่ซิงค์ไปแล้ว)',
    confirmText: 'ลบ', confirmClass: 'danger',
  });
  if (!ok) return;
  try {
    await fetchJson('/api/history?row=' + row, { method: 'DELETE' });
    log('ลบประวัติแล้ว');
    await loadHistory();
  } catch (e) {
    await showAlert({ iconName: 'xCircle', title: 'ลบไม่สำเร็จ', desc: escHtml(e.message), confirmClass: 'danger' });
  }
}

async function clearAllHistory() {
  const ok = await showConfirm({
    iconName: 'trash', title: 'ล้างประวัติทั้งหมด?',
    desc: 'จะลบประวัติการซิงค์<b>ทั้งหมด</b>ออกถาวร (ไม่กระทบข้อมูลที่ซิงค์ไปแล้ว)<br>ต้องการดำเนินการ?',
    confirmText: 'ล้างทั้งหมด', confirmClass: 'danger',
  });
  if (!ok) return;
  try {
    await fetchJson('/api/history?all=1', { method: 'DELETE' });
    log('ล้างประวัติทั้งหมดแล้ว');
    await loadHistory();
  } catch (e) {
    await showAlert({ iconName: 'xCircle', title: 'ล้างไม่สำเร็จ', desc: escHtml(e.message), confirmClass: 'danger' });
  }
}

// ──────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────
async function bootstrap() {
  try {
    const cfg = await fetchJson('/api/config');
    CONFIG.historySheetId = cfg.historySheetId;
    CONFIG.allowedDomain  = cfg.allowedDomain;
    CONFIG.adminEmails    = (cfg.adminEmails || []).map(s => String(s).toLowerCase());
    CONFIG.localTest      = !!cfg.localTest;
    $('histLabel').textContent = cfg.historySheetId || '(missing)';
    log('Config loaded', cfg);
  } catch (e) {
    log('Config error: ' + e.message);
  }

  // Local test server sets localTest — enable the form without any login/email.
  // Production's /api/config never returns this flag, so prod is unaffected.
  if (CONFIG.localTest) {
    state.refreshToken = state.refreshToken || 'local';
    state.userEmail    = state.userEmail    || 'local-test';
    setAuthed(true);
    log('Local test mode — ไม่ต้อง login');
  } else if (state.refreshToken && state.userEmail) {
    setAuthed(true);
  } else {
    updateInfoRow();
  }
  updateTabVisibility();
}

function bindEvents() {
  $('btnLogin').onclick    = startLogin;
  $('btnLogout').onclick   = logout;
  $('syncDirection').onchange = (ev) => setMode(ev.target.value);
  $('syncInterval').onchange = onIntervalChange;
  $('sheetUrl').oninput = () => markInvalid('sheetUrl', false);
  $('larkUrl').oninput  = () => markInvalid('larkUrl', false);
  $('btnSyncNow').onclick  = syncNow;
  $('btnSaveCron').onclick = saveCron;
  $('btnReloadCron').onclick = loadPairs;
  bindTabs();
  $('btnReset').onclick    = resetForm;
  $('btnDiagLinks').onclick = diagLinks;
  $('btnReloadHistory').onclick = loadHistory;
  $('btnClearHistory').onclick = clearAllHistory;
  $('btnPickColumns').onclick = scanColumns;
  $('colApply').onclick    = applyColSelection;
  $('colCancel').onclick   = closeColModal;
  $('colAll').onclick      = () => { _colWorking = new Set(state.sourceColumns); renderColList($('colSearch').value); };
  $('colNone').onclick     = () => { _colWorking = new Set(); renderColList($('colSearch').value); };
  $('colSearch').oninput   = (ev) => renderColList(ev.target.value);
  $('btnFilter').onclick   = openFilterModal;
  $('filterApply').onclick = applyFilters;
  $('filterCancel').onclick = closeFilterModal;
  $('filterClear').onclick = () => { _filterWorking = new Map(); renderFilterFields(); };
  window.addEventListener('message', onOauthMessage);
}

// TEMP diagnostic — inspect how the source sheet stores links in each column.
async function diagLinks(){
  const out = $('diagOut');
  const sheetUrl = $('sheetUrl').value.trim();
  out.style.display = 'block';
  if(!state.refreshToken){ out.textContent = 'ยังไม่ได้ login (ไม่มี refreshToken)'; return; }
  if(!sheetUrl){ out.textContent = 'ใส่ Google Sheet URL ในช่องด้านบนก่อน'; return; }
  out.textContent = 'กำลังตรวจ...';
  try {
    const r = await fetch('/api/diag-links', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refreshToken, sheetUrl }),
    });
    const d = await r.json();
    if(!d.ok){ out.textContent = 'ERROR: ' + (d.error || JSON.stringify(d)); return; }
    // Show only columns that carry any link, plus their samples.
    const linky = (d.cols || []).filter(c => c.nHyperlink || c.nFormula || c.nRunLink);
    const lines = [`แท็บ: ${d.tab}`, `คอลัมน์ทั้งหมด: ${(d.headers||[]).length}`, `คอลัมน์ที่มีลิงก์: ${linky.length}`, ''];
    (linky.length ? linky : d.cols.slice(0, 8)).forEach(c => {
      lines.push(`▸ [${c.header}] cells=${c.nCells} hyperlink=${c.nHyperlink} formula=${c.nFormula} runLink=${c.nRunLink}`);
      (c.samples || []).forEach(s => {
        lines.push(`    row${s.row}: "${s.text}"`);
        if(s.hyperlink) lines.push(`        hyperlink: ${s.hyperlink}`);
        if(s.formula)   lines.push(`        formula:   ${s.formula}`);
        if(s.runLink)   lines.push(`        runLink:   ${s.runLink}`);
      });
    });
    out.textContent = lines.join('\n');
  } catch(e){ out.textContent = 'ERROR: ' + e.message; }
}

bindEvents();
bootstrap();
