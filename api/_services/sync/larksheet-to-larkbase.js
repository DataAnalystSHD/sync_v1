import { getSheetValues, cellTextValue } from "../../_lib/lark/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched, larkCountRecords } from "../../_lib/lark/records.js";
import { larkEnsureFields, larkListFields } from "../../_lib/lark/fields.js";
import { inferType, inferProperty, convertForLark } from "../../_lib/lark/infer-types.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
import { updateCursor, updatePhase } from "../pairs-store.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

const PHASE_RUNNING = "larksheet2larkbase_running";
const PHASE_IDLE    = "idle";
const INFER_SAMPLE_ROWS = 100;

async function readHeaders({ ssToken, sheetId }){
  const rows = await getSheetValues({ ssToken, sheetId, range: "A1:CZ1" });
  const raw = rows?.[0] || [];
  const headers = raw
    .map(v => cellTextValue(v).trim())
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
  return headers.map((name, i) => {
    const samples = (rows || []).map(r => r[i]);
    const type = inferType(samples);
    return { name, type, property: inferProperty(samples, type) };
  });
}

async function beginNewRun({ accessToken, cfg, ssToken, srcSheetId, baseId, tableId, headers, endCol, rowId, syncMode, selectedSet }){
  if(rowId){
    await updatePhase({ accessToken, cfg, rowId, phase: PHASE_RUNNING });
    await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
  }
  // Infer at full source width, then keep only the selected columns' fields.
  let fields = await inferFieldsFromLarkSheet({ ssToken, sheetId: srcSheetId, headers, endCol });
  if(selectedSet) fields = fields.filter(f => selectedSet.has(f.name));
  const { typeMap, nameMap } = await larkEnsureFields({ baseId, tableId, fields });
  if(syncMode !== "append"){
    await larkBatchDeleteAll({ baseId, tableId });
  }
  return { typeMap, nameMap };
}

async function finishRun({ accessToken, cfg, rowId }){
  if(!rowId) return;
  await updatePhase({ accessToken, cfg, rowId, phase: PHASE_IDLE });
  await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
}

async function readTypeMap({ baseId, tableId }){
  const fields = await larkListFields({ baseId, tableId });
  // For resume runs we don't have the original requested names, so the
  // typeMap is keyed by the actual Bitable name and we treat that as the
  // canonical key (nameMap is an identity).
  const typeMap = new Map(fields.map(f => [f.field_name, f.type]));
  const nameMap = new Map(fields.map(f => [f.field_name, f.field_name]));
  return { typeMap, nameMap };
}

function isEmptyCell(v){
  if(v === null || v === undefined) return true;
  if(typeof v === "string") return v.trim() === "";
  if(Array.isArray(v)) return v.length === 0 || v.every(isEmptyCell);
  return false;
}

function isEmptyRow(row){
  if(!row || row.length === 0) return true;
  return row.every(isEmptyCell);
}

function rowsToRecords(rows, headers, typeMap, nameMap){
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const text = cellTextValue(row[idx]);
      const converted = convertForLark(text, typeMap.get(h) || 1);
      if(converted !== undefined){
        const key = nameMap?.get(h) || h;
        obj[key] = converted;
      }
    });
    return obj;
  });
}

export async function syncLarkSheetToLarkBase({ accessToken, cfg, sourceUrl, baseId, tableId, pair, rowFrom, rowTo, syncMode, columns }){
  const { ssToken, sheetId } = await resolveLarkSheetTarget(sourceUrl);
  const fullHeaders = await readHeaders({ ssToken, sheetId });
  // Column selection (empty = all). Read at full width so cell indices line up,
  // then project each read down to the selected columns before writing.
  const { headers, indices } = selectColumns(fullHeaders, columns);
  const selectedSet = new Set(headers);
  const endCol  = endColumnFor(fullHeaders);          // full source read width
  const pick = (rows) => (rows || []).map(r => indices.map(i => r[i]));
  const pageSize = cfg.pageSize;
  const rowId = pair?.rowId;
  const isAppend = syncMode === "append";

  // ── Append: add only the rows the destination doesn't have yet ──
  // Destination record count is the high-water mark, so a recurring sync never
  // re-appends rows it already wrote (and survives a Replace→Append switch).
  // Row Range is intentionally ignored for append.
  if(isAppend){
    const existing = await larkCountRecords({ baseId, tableId });
    let typeMap, nameMap;
    if(existing === 0){
      let fields = await inferFieldsFromLarkSheet({ ssToken, sheetId, headers: fullHeaders, endCol });
      fields = fields.filter(f => selectedSet.has(f.name));
      ({ typeMap, nameMap } = await larkEnsureFields({ baseId, tableId, fields }));
    } else {
      ({ typeMap, nameMap } = await readTypeMap({ baseId, tableId }));
    }
    const startSheetRow = 2 + existing;   // header is row 1; skip rows already appended
    const endSheetRow   = startSheetRow + pageSize - 1;
    const rawValues = await getSheetValues({ ssToken, sheetId, range: `A${startSheetRow}:${endCol}${endSheetRow}` });
    const nonEmpty  = (rawValues || []).filter(r => !isEmptyRow(r));
    if(nonEmpty.length === 0){
      return { rowCount: 0, truncated: false, done: true };
    }
    const records = rowsToRecords(pick(nonEmpty), headers, typeMap, nameMap);
    await larkCreateRecordsBatched({ baseId, tableId, records });
    return {
      rowCount: records.length,
      truncated: false,
      done: (rawValues?.length || 0) < pageSize,
      page: { startRow: startSheetRow, endRow: startSheetRow + (rawValues?.length || 0) - 1, pageSize },
    };
  }

  // ── Replace (and range one-shot): paginated full refresh ──
  const hasRange = rowFrom != null || rowTo != null;
  const isFresh = shouldStartFresh(pair) || hasRange;
  let cursorRow = Number(pair?.cursorRow || 2);

  // Read the page FIRST — before any destructive delete — so an empty or failed
  // source read can never wipe the destination on a Replace.
  // 1-based data rows → sheet rows = +1 (skip header at row 1).
  const startSheetRow = hasRange ? ((rowFrom || 1) + 1) : (isFresh ? 2 : cursorRow);
  const endSheetRow   = hasRange
    ? (rowTo ? (rowTo + 1) : startSheetRow + pageSize - 1)
    : (startSheetRow + pageSize - 1);
  const range = `A${startSheetRow}:${endCol}${endSheetRow}`;

  const rawValues = await getSheetValues({ ssToken, sheetId, range });
  const nonEmpty  = (rawValues || []).filter(r => !isEmptyRow(r));

  if(nonEmpty.length === 0){
    // No source rows → do NOT delete anything; leave the destination intact.
    if(rowId) await finishRun({ accessToken, cfg, rowId });
    return { rowCount: 0, truncated: false, done: true };
  }

  let typeMap, nameMap;
  if(isFresh){
    ({ typeMap, nameMap } = await beginNewRun({
      accessToken, cfg,
      ssToken, srcSheetId: sheetId,
      baseId, tableId, headers: fullHeaders, endCol, rowId, syncMode, selectedSet,
    }));
    cursorRow = 2;
  } else {
    ({ typeMap, nameMap } = await readTypeMap({ baseId, tableId }));
  }

  const records = rowsToRecords(pick(nonEmpty), headers, typeMap, nameMap);
  await larkCreateRecordsBatched({ baseId, tableId, records });

  if(hasRange){
    await finishRun({ accessToken, cfg, rowId });
    return {
      rowCount: records.length,
      truncated: false,
      done: true,
      page: { startRow: startSheetRow, endRow: startSheetRow + records.length - 1, pageSize: records.length },
      nextCursorRow: null,
    };
  }

  const done = nonEmpty.length < pageSize;
  const nextCursor = cursorRow + (rawValues?.length || 0);
  if(rowId){
    if(done) await finishRun({ accessToken, cfg, rowId });
    else     await updateCursor({ accessToken, cfg, rowId, cursorRow: nextCursor });
  }

  return {
    rowCount: records.length,
    truncated: false,
    done,
    page: { startRow: cursorRow, endRow: cursorRow + (rawValues?.length || 0) - 1, pageSize },
    nextCursorRow: done ? null : nextCursor,
  };
}
