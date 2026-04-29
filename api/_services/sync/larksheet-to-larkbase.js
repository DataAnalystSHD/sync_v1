import { getSheetValues } from "../../_lib/lark/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched } from "../../_lib/lark/records.js";
import { larkEnsureFields, larkListFields } from "../../_lib/lark/fields.js";
import { inferType, convertForLark } from "../../_lib/lark/infer-types.js";
import { endColumnFor } from "../../_lib/urls.js";
import { updateCursor, updatePhase } from "../pairs-store.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

const PHASE_RUNNING = "larksheet2larkbase_running";
const PHASE_IDLE    = "idle";
const INFER_SAMPLE_ROWS = 100;

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

async function inferFieldsFromLarkSheet({ ssToken, sheetId, headers, endCol }){
  const range = `A2:${endCol}${1 + INFER_SAMPLE_ROWS}`;
  const rows  = await getSheetValues({ ssToken, sheetId, range });
  return headers.map((name, i) => ({
    name,
    type: inferType((rows || []).map(r => r[i])),
  }));
}

async function beginNewRun({ accessToken, cfg, ssToken, srcSheetId, baseId, tableId, headers, endCol, rowId }){
  if(rowId){
    await updatePhase({ accessToken, cfg, rowId, phase: PHASE_RUNNING });
    await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
  }
  const fields = await inferFieldsFromLarkSheet({ ssToken, sheetId: srcSheetId, headers, endCol });
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
      const v = row[idx];
      const text = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
      const converted = convertForLark(text, typeMap.get(h) || 1);
      if(converted !== undefined) obj[h] = converted;
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
  let typeMap;
  if(shouldStartFresh(pair)){
    typeMap = await beginNewRun({
      accessToken, cfg,
      ssToken, srcSheetId: sheetId,
      baseId, tableId, headers, endCol, rowId,
    });
    cursorRow = 2;
  } else {
    typeMap = await readTypeMap({ baseId, tableId });
  }

  const start = cursorRow;
  const end   = cursorRow + pageSize - 1;
  const range = `A${start}:${endCol}${end}`;

  const values = await getSheetValues({ ssToken, sheetId, range });

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
