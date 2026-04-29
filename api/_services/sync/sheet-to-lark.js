import { sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched } from "../../_lib/lark/records.js";
import { larkEnsureFields, larkListFields } from "../../_lib/lark/fields.js";
import { inferType, inferProperty, convertForLark } from "../../_lib/lark/infer-types.js";
import { endColumnFor } from "../../_lib/urls.js";
import { updateCursor, updatePhase } from "../pairs-store.js";

const PHASE_RUNNING = "sheet2lark_running";
const PHASE_IDLE    = "idle";
const INFER_SAMPLE_ROWS = 100;

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

async function inferFieldsFromSheet({ accessToken, sheetId, tab, headers, endCol }){
  const range = `${tab}A2:${endCol}${1 + INFER_SAMPLE_ROWS}`;
  const rows  = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });
  return headers.map((name, i) => {
    const samples = (rows || []).map(r => r[i]);
    const type = inferType(samples);
    return { name, type, property: inferProperty(samples, type) };
  });
}

async function beginNewRun({ accessToken, cfg, sheetId, tab, baseId, tableId, headers, endCol, rowId }){
  if(rowId){
    await updatePhase({ accessToken, cfg, rowId, phase: PHASE_RUNNING });
    await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
  }
  const fields = await inferFieldsFromSheet({ accessToken, sheetId, tab, headers, endCol });
  const { typeMap } = await larkEnsureFields({ baseId, tableId, fields });
  await larkBatchDeleteAll({ baseId, tableId });
  return typeMap;
}

async function finishRun({ accessToken, cfg, rowId }){
  if(!rowId) return;
  await updatePhase({ accessToken, cfg, rowId, phase: PHASE_IDLE });
  await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
}

async function readTypeMap({ baseId, tableId }){
  const fields = await larkListFields({ baseId, tableId });
  return new Map(fields.map(f => [f.field_name, f.type]));
}

function rowsToRecords(rows, headers, typeMap){
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const v = convertForLark(row[idx], typeMap.get(h) || 1);
      if(v !== undefined) obj[h] = v;
    });
    return obj;
  });
}

/**
 * Pages from cursor → cursor+pageSize, persists progress in M/N for cron resume.
 * Manual/auto runs pass forceNew=true to clear & restart from row 2 each call.
 *
 * On a fresh start the first ~100 data rows are sampled to infer Lark field
 * types (Number / DateTime / Checkbox / Text), and any new fields are created
 * with the inferred type. Existing fields keep whatever type they already have.
 */
export async function syncSheetToLark({ accessToken, cfg, sheetId, gid, baseId, tableId, pair }){
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: sheetId, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const headers = await readHeaders({ accessToken, sheetId, tab });
  const endCol = endColumnFor(headers);
  const pageSize = cfg.pageSize;
  const rowId = pair?.rowId;

  let cursorRow = Number(pair?.cursorRow || 2);
  let typeMap;
  if(shouldStartFresh(pair)){
    typeMap = await beginNewRun({ accessToken, cfg, sheetId, tab, baseId, tableId, headers, endCol, rowId });
    cursorRow = 2;
  } else {
    typeMap = await readTypeMap({ baseId, tableId });
  }

  const start = cursorRow;
  const end   = cursorRow + pageSize - 1;
  const range = `${tab}A${start}:${endCol}${end}`;

  const values = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });

  if(!values || values.length === 0){
    await finishRun({ accessToken, cfg, rowId });
    return { rowCount: 0, truncated: false, done: true };
  }

  const records = rowsToRecords(values, headers, typeMap);
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
