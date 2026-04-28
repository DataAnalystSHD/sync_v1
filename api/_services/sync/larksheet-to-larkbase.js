import { getSheetValues } from "../../_lib/lark/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched } from "../../_lib/lark/records.js";
import { larkEnsureFields } from "../../_lib/lark/fields.js";
import { endColumnFor } from "../../_lib/urls.js";
import { updateCursor, updatePhase } from "../pairs-store.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

const PHASE_RUNNING = "larksheet2larkbase_running";
const PHASE_IDLE    = "idle";

async function readHeaders({ ssToken, sheetId }){
  const rows = await getSheetValues({ ssToken, sheetId, range: "A1:CZ1" });
  const raw = rows?.[0] || [];
  const headers = raw
    .map(v => (v == null ? "" : String(v).trim()))
    .filter(v => v !== "");
  if(headers.length === 0) throw new Error("Lark Sheet has no header row (row 1 must contain headers)");
  return headers;
}

function shouldStartFresh(pair){
  const cursor = Number(pair?.cursorRow || 2);
  if(pair?.forceNew === true) return true;
  if((pair?.phase || PHASE_IDLE) !== PHASE_RUNNING) return true;
  if(cursor <= 2) return true;
  return false;
}

async function beginNewRun({ accessToken, cfg, baseId, tableId, headers, rowId }){
  if(rowId){
    await updatePhase({ accessToken, cfg, rowId, phase: PHASE_RUNNING });
    await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
  }
  await larkEnsureFields({ baseId, tableId, fieldNames: headers });
  await larkBatchDeleteAll({ baseId, tableId });
}

async function finishRun({ accessToken, cfg, rowId }){
  if(!rowId) return;
  await updatePhase({ accessToken, cfg, rowId, phase: PHASE_IDLE });
  await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
}

function rowsToRecords(rows, headers){
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const v = row[idx];
      obj[h] = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
    });
    return obj;
  });
}

export async function syncLarkSheetToLarkBase({ accessToken, cfg, sourceUrl, baseId, tableId, pair }){
  const { ssToken, sheetId } = await resolveLarkSheetTarget(sourceUrl);
  const headers = await readHeaders({ ssToken, sheetId });
  const endCol  = endColumnFor(headers);
  const pageSize = cfg.pageSize;
  const rowId = pair?.rowId;

  let cursorRow = Number(pair?.cursorRow || 2);
  if(shouldStartFresh(pair)){
    await beginNewRun({ accessToken, cfg, baseId, tableId, headers, rowId });
    cursorRow = 2;
  }

  const start = cursorRow;
  const end   = cursorRow + pageSize - 1;
  const range = `A${start}:${endCol}${end}`;

  const values = await getSheetValues({ ssToken, sheetId, range });

  if(!values || values.length === 0){
    await finishRun({ accessToken, cfg, rowId });
    return { rowCount: 0, truncated: false, done: true };
  }

  const records = rowsToRecords(values, headers);
  await larkCreateRecordsBatched({ baseId, tableId, records });

  const nextCursor = cursorRow + records.length;
  if(rowId) await updateCursor({ accessToken, cfg, rowId, cursorRow: nextCursor });

  return {
    rowCount: records.length,
    truncated: false,
    done: false,
    page: { startRow: cursorRow, endRow: nextCursor - 1, pageSize },
    nextCursorRow: nextCursor,
  };
}
