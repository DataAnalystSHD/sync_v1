import { sheetsGetValues, sheetsUpdate, sheetsClear } from "../_lib/google/sheets.js";
import { parseColumns } from "../_lib/columns.js";
import { parseFilters } from "../_lib/filters.js";

const COLUMNS = {
  createdAt:   "A",
  sheetUrl:    "B",
  sheetId:     "C",
  larkUrl:     "D",
  baseId:      "E",
  tableId:     "F",
  direction:   "G",
  user:        "H",
  refreshEnc:  "I",
  active:      "J",
  lastSyncAt:  "K",
  notes:       "L",
  cursorRow:   "M",
  phase:       "N",
  intervalMin: "O",
  rowFrom:     "P",
  rowTo:       "Q",
  syncMode:    "R",
  team:        "S",
  columns:     "T",
  filters:     "U",
  noHeader:    "V",
};

const LAST_COL = "V";

function toPos(v){
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function rowToPair(r, rowNum){
  return {
    rowId:       rowNum,
    createdAt:   r[0]  || "",
    sheetUrl:    r[1]  || "",
    sheetId:     r[2]  || "",
    larkUrl:     r[3]  || "",
    baseId:      r[4]  || "",
    tableId:     r[5]  || "",
    direction:   r[6]  || "lark-to-sheet",
    user:        r[7]  || "",
    refreshEnc:  r[8]  || "",
    active:      String(r[9] || "TRUE").toUpperCase() !== "FALSE",
    lastSyncAt:  r[10] || "",
    notes:       r[11] || "",
    cursorRow:   parseInt(r[12] || "2", 10),
    phase:       r[13] || "idle",
    intervalMin: toPos(r[14]) || 60,
    rowFrom:     toPos(r[15]),
    rowTo:       toPos(r[16]),
    syncMode:    (r[17] === "append" ? "append" : "replace"),
    team:        String(r[18] || "").trim().toLowerCase(),
    columns:     parseColumns(r[19]),
    filters:     parseFilters(r[20]),
    noHeader:    String(r[21] || "").trim().toUpperCase() === "TRUE",
  };
}

export async function readAllPairs({ accessToken, cfg }){
  const rows = await sheetsGetValues({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A1:${LAST_COL}20000`,
  });
  // Identify real pairs by an http(s) URL in the sheetUrl column (B) — robust
  // to a missing/extra header row, blank rows, and soft-deleted (cleared) rows.
  // rowId is the actual sheet row number (1-based), used by the update/delete ops.
  const out = [];
  rows.forEach((r, idx) => {
    if(/^https?:\/\//i.test(String(r[1] || "")) && /^https?:\/\//i.test(String(r[3] || ""))){
      out.push(rowToPair(r, idx + 1));
    }
  });
  return out;
}

// Pairs tagged for a given team (case-insensitive). Empty team = ungrouped,
// only returned when `team` itself is empty.
export async function readPairsForTeam({ accessToken, cfg, team }){
  const want = String(team || "").trim().toLowerCase();
  const all = await readAllPairs({ accessToken, cfg });
  return all.filter(p => p.team === want);
}

export async function readActiveCronPairs({ accessToken, cfg }){
  const all = await readAllPairs({ accessToken, cfg });
  // The sync runner re-parses every URL itself, so a cron pair only needs a
  // valid source/dest URL pair plus its own encrypted token to run.
  return all.filter(p => p.active && p.refreshEnc && p.sheetUrl && p.larkUrl);
}

export async function readActivePairs({ accessToken, cfg }){
  const all = await readAllPairs({ accessToken, cfg });
  return all.filter(p => p.active && p.sheetId && p.baseId && p.tableId);
}

export async function appendPair({ accessToken, cfg, pair }){
  const row = [
    new Date().toISOString(),        // A createdAt
    pair.sheetUrl,                   // B
    pair.sheetId || "",              // C
    pair.larkUrl,                    // D
    pair.baseId || "",               // E
    pair.tableId || "",              // F
    pair.direction,                  // G
    pair.userEmail || "",            // H
    pair.refreshEnc,                 // I
    "TRUE",                          // J active
    "",                              // K lastSyncAt
    "",                              // L notes
    "2",                             // M cursorRow
    "idle",                          // N phase
    String(toPos(pair.intervalMin) || 60),  // O intervalMin
    pair.rowFrom ? String(pair.rowFrom) : "", // P
    pair.rowTo   ? String(pair.rowTo)   : "", // Q
    pair.syncMode === "append" ? "append" : "replace", // R
    String(pair.team || "").trim().toLowerCase(),      // S team
    Array.isArray(pair.columns) && pair.columns.length ? JSON.stringify(pair.columns) : "", // T columns
    Array.isArray(pair.filters) && pair.filters.length ? JSON.stringify(pair.filters) : "", // U filters
    pair.noHeader ? "TRUE" : "",                                                            // V noHeader
  ];
  // Don't use values.append: its table auto-detection has shifted new rows
  // into the wrong columns (data ended up starting at column R) after rows
  // were cleared. Find the next free row ourselves and write there explicitly.
  const existing = await sheetsGetValues({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A1:${LAST_COL}20000`,
  });
  const nextRow = (existing?.length || 0) + 1;
  await sheetsUpdate({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A${nextRow}:${LAST_COL}${nextRow}`,
    values: [row],
  });
}

async function updateCell({ accessToken, cfg, rowId, col, value }){
  await sheetsUpdate({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!${col}${rowId}:${col}${rowId}`,
    values: [[value]],
  });
}

export function setActive({ accessToken, cfg, rowId, active }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.active, value: active ? "TRUE" : "FALSE" });
}

// Edit an existing pair's config in place (only the fields provided are written).
export async function updatePairFields({ accessToken, cfg, rowId, fields }){
  const jobs = [];
  const set = (col, value) => jobs.push(updateCell({ accessToken, cfg, rowId, col, value }));
  if(fields.sheetUrl    != null) set(COLUMNS.sheetUrl,   fields.sheetUrl);
  if(fields.sheetId     != null) set(COLUMNS.sheetId,    fields.sheetId);
  if(fields.larkUrl     != null) set(COLUMNS.larkUrl,    fields.larkUrl);
  if(fields.baseId      != null) set(COLUMNS.baseId,     fields.baseId);
  if(fields.tableId     != null) set(COLUMNS.tableId,    fields.tableId);
  if(fields.direction   != null) set(COLUMNS.direction,  fields.direction);
  if(fields.syncMode    != null) set(COLUMNS.syncMode,   fields.syncMode === "append" ? "append" : "replace");
  if(fields.intervalMin != null) set(COLUMNS.intervalMin, String(toPos(fields.intervalMin) || 60));
  if(fields.columns     != null) set(COLUMNS.columns, Array.isArray(fields.columns) && fields.columns.length ? JSON.stringify(fields.columns) : "");
  if(fields.filters     != null) set(COLUMNS.filters, Array.isArray(fields.filters) && fields.filters.length ? JSON.stringify(fields.filters) : "");
  if(fields.noHeader    != null) set(COLUMNS.noHeader, fields.noHeader ? "TRUE" : "");
  await Promise.all(jobs);
}

export function setPairInterval({ accessToken, cfg, rowId, intervalMin }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.intervalMin, value: String(toPos(intervalMin) || 60) });
}

export function setSyncMode({ accessToken, cfg, rowId, syncMode }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.syncMode, value: syncMode === "append" ? "append" : "replace" });
}

export async function findPairByRowId({ accessToken, cfg, rowId }){
  const all = await readAllPairs({ accessToken, cfg });
  return all.find(p => p.rowId === rowId) || null;
}

// Soft delete: blank the whole row so it drops out of every read (rowToPair
// filters out rows without URLs). Avoids needing the tab's numeric gid for a
// real deleteDimension batchUpdate.
export async function deletePairRow({ accessToken, cfg, rowId }){
  await sheetsClear({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A${rowId}:${LAST_COL}${rowId}`,
  });
}

export function updateLastSync({ accessToken, cfg, rowId }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.lastSyncAt, value: new Date().toISOString() });
}

export function updateCursor({ accessToken, cfg, rowId, cursorRow }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.cursorRow, value: String(cursorRow) });
}

export function updatePhase({ accessToken, cfg, rowId, phase }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.phase, value: phase });
}
