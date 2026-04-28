import { sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched } from "../../_lib/lark/records.js";
import { larkEnsureFields } from "../../_lib/lark/fields.js";
import { endColumnFor } from "../../_lib/urls.js";
import { updateCursor, updatePhase } from "../pairs-store.js";

const PHASE_RUNNING = "sheet2lark_running";
const PHASE_IDLE    = "idle";

async function readHeaders({ accessToken, sheetId, tab }){
  const header = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range: `${tab}A1:1` });
  const headers = header?.[0] || [];
  if(headers.length === 0) throw new Error("Sheet has no header row (row 1 must contain headers)");
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
    headers.forEach((h, idx) => obj[h] = row[idx] ?? "");
    return obj;
  });
}

/**
 * Pages from cursor → cursor+pageSize, persists progress in M/N for cron resume.
 * Manual/auto runs pass forceNew=true to clear & restart from row 2 each call.
 */
export async function syncSheetToLark({ accessToken, cfg, sheetId, gid, baseId, tableId, pair }){
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: sheetId, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const headers = await readHeaders({ accessToken, sheetId, tab });
  const endCol = endColumnFor(headers);
  const pageSize = cfg.pageSize;
  const rowId = pair?.rowId;

  let cursorRow = Number(pair?.cursorRow || 2);
  if(shouldStartFresh(pair)){
    await beginNewRun({ accessToken, cfg, baseId, tableId, headers, rowId });
    cursorRow = 2;
  }

  const start = cursorRow;
  const end   = cursorRow + pageSize - 1;
  const range = `${tab}A${start}:${endCol}${end}`;

  const values = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });

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
