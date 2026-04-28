import { sheetsGetValues, sheetsAppend, sheetsUpdate } from "../_lib/google/sheets.js";

const COLUMNS = {
  createdAt:  "A",
  sheetUrl:   "B",
  sheetId:    "C",
  larkUrl:    "D",
  baseId:     "E",
  tableId:    "F",
  direction:  "G",
  user:       "H",
  refreshEnc: "I",
  active:     "J",
  lastSyncAt: "K",
  notes:      "L",
  cursorRow:  "M",
  phase:      "N",
};

function rowToPair(r, idx){
  return {
    rowId:      idx + 2,
    createdAt:  r[0]  || "",
    sheetUrl:   r[1]  || "",
    sheetId:    r[2]  || "",
    larkUrl:    r[3]  || "",
    baseId:     r[4]  || "",
    tableId:    r[5]  || "",
    direction:  r[6]  || "lark-to-sheet",
    user:       r[7]  || "",
    refreshEnc: r[8]  || "",
    active:     String(r[9] || "TRUE").toUpperCase() !== "FALSE",
    lastSyncAt: r[10] || "",
    notes:      r[11] || "",
    cursorRow:  parseInt(r[12] || "2", 10),
    phase:      r[13] || "idle",
  };
}

export async function readAllPairs({ accessToken, cfg }){
  const rows = await sheetsGetValues({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A1:N20000`,
  });
  if(rows.length <= 1) return [];
  return rows.slice(1).map(rowToPair);
}

export async function readActiveCronPairs({ accessToken, cfg }){
  const all = await readAllPairs({ accessToken, cfg });
  return all.filter(p => p.active && p.sheetId && p.baseId && p.tableId && p.refreshEnc);
}

export async function readActivePairs({ accessToken, cfg }){
  const all = await readAllPairs({ accessToken, cfg });
  return all.filter(p => p.active && p.sheetId && p.baseId && p.tableId);
}

export async function appendPair({ accessToken, cfg, pair }){
  const row = [
    new Date().toISOString(),
    pair.sheetUrl,
    pair.sheetId,
    pair.larkUrl,
    pair.baseId,
    pair.tableId,
    pair.direction,
    pair.userEmail || "",
    pair.refreshEnc,
    "TRUE",
    "",
    "",
  ];
  await sheetsAppend({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A:L`,
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

export function updateLastSync({ accessToken, cfg, rowId }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.lastSyncAt, value: new Date().toISOString() });
}

export function updateCursor({ accessToken, cfg, rowId, cursorRow }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.cursorRow, value: String(cursorRow) });
}

export function updatePhase({ accessToken, cfg, rowId, phase }){
  return updateCell({ accessToken, cfg, rowId, col: COLUMNS.phase, value: phase });
}
