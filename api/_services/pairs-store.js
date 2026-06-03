import { sheetsGetValues, sheetsAppend, sheetsUpdate, sheetsClear } from "../_lib/google/sheets.js";

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
};

const LAST_COL = "R";

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
  ];
  await sheetsAppend({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A:${LAST_COL}`,
    values: row,
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

export function setPairInterval({ accessToken, cfg, rowId, intervalMin }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.intervalMin, value: String(toPos(intervalMin) || 60) });
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
