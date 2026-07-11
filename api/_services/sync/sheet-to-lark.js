import { sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched, larkCountRecords } from "../../_lib/lark/records.js";
import { larkEnsureFields, larkListFields } from "../../_lib/lark/fields.js";
import { inferType, inferProperty, convertForLark } from "../../_lib/lark/infer-types.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
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

async function beginNewRun({ accessToken, cfg, sheetId, tab, baseId, tableId, headers, endCol, rowId, syncMode, selectedSet }){
  if(rowId){
    await updatePhase({ accessToken, cfg, rowId, phase: PHASE_RUNNING });
    await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
  }
  // Infer at full source width, then keep only the selected columns' fields.
  let fields = await inferFieldsFromSheet({ accessToken, sheetId, tab, headers, endCol });
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
  const typeMap = new Map(fields.map(f => [f.field_name, f.type]));
  const nameMap = new Map(fields.map(f => [f.field_name, f.field_name]));
  return { typeMap, nameMap };
}

function rowsToRecords(rows, headers, typeMap, nameMap){
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const v = convertForLark(row[idx], typeMap.get(h) || 1);
      if(v !== undefined){
        const key = nameMap?.get(h) || h;
        obj[key] = v;
      }
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
export async function syncSheetToLark({ accessToken, cfg, sheetId, gid, baseId, tableId, pair, rowFrom, rowTo, syncMode, columns }){
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: sheetId, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const fullHeaders = await readHeaders({ accessToken, sheetId, tab });
  // Column selection (empty = all). Read the sheet at full width so cell indices
  // line up, then project each read down to the selected columns before writing.
  const { headers, indices } = selectColumns(fullHeaders, columns);
  const selectedSet = new Set(headers);
  const endCol = endColumnFor(fullHeaders);          // full source read width
  const pick = (rows) => (rows || []).map(r => indices.map(i => r[i]));
  const pageSize = cfg.pageSize;
  const rowId = pair?.rowId;
  const isAppend = syncMode === "append";

  // ── Append: add only the source rows the destination doesn't have yet ──
  // The destination record count is the high-water mark, so a recurring sync
  // never re-appends rows it already wrote — and it stays correct after a
  // Replace→Append switch. Row Range is intentionally ignored for append.
  if(isAppend){
    const existing = await larkCountRecords({ baseId, tableId });
    let typeMap, nameMap;
    if(existing === 0){
      let fields = await inferFieldsFromSheet({ accessToken, sheetId, tab, headers: fullHeaders, endCol });
      fields = fields.filter(f => selectedSet.has(f.name));
      ({ typeMap, nameMap } = await larkEnsureFields({ baseId, tableId, fields }));
    } else {
      ({ typeMap, nameMap } = await readTypeMap({ baseId, tableId }));
    }
    const startSheetRow = 2 + existing;   // header is row 1; skip rows already appended
    const endSheetRow   = startSheetRow + pageSize - 1;
    const values = await sheetsGetValues({
      accessToken, spreadsheetId: sheetId,
      range: `${tab}A${startSheetRow}:${endCol}${endSheetRow}`,
    });
    if(!values || values.length === 0){
      return { rowCount: 0, truncated: false, done: true };
    }
    const records = rowsToRecords(pick(values), headers, typeMap, nameMap);
    await larkCreateRecordsBatched({ baseId, tableId, records });
    return {
      rowCount: records.length,
      truncated: false,
      done: values.length < pageSize,
      page: { startRow: startSheetRow, endRow: startSheetRow + records.length - 1, pageSize },
    };
  }

  // ── Replace (and range one-shot): paginated full refresh ──
  const hasRange = rowFrom != null || rowTo != null;
  const isFresh = shouldStartFresh(pair) || hasRange;
  let cursorRow = Number(pair?.cursorRow || 2);

  // Read the page FIRST — before any destructive delete — so an empty or failed
  // source read can never wipe the destination on a Replace.
  // Data rows are 1-indexed for the user; sheet rows are 2..N (after header).
  const startSheetRow = hasRange ? ((rowFrom || 1) + 1) : (isFresh ? 2 : cursorRow);
  const endSheetRow   = hasRange
    ? (rowTo ? (rowTo + 1) : startSheetRow + pageSize - 1)
    : (startSheetRow + pageSize - 1);
  const range = `${tab}A${startSheetRow}:${endCol}${endSheetRow}`;

  const values = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });

  if(!values || values.length === 0){
    // No source rows → do NOT delete anything; leave the destination intact.
    if(rowId) await finishRun({ accessToken, cfg, rowId });
    return { rowCount: 0, truncated: false, done: true };
  }

  let typeMap, nameMap;
  if(isFresh){
    ({ typeMap, nameMap } = await beginNewRun({ accessToken, cfg, sheetId, tab, baseId, tableId, headers: fullHeaders, endCol, rowId, syncMode, selectedSet }));
    cursorRow = 2;
  } else {
    ({ typeMap, nameMap } = await readTypeMap({ baseId, tableId }));
  }

  const records = rowsToRecords(pick(values), headers, typeMap, nameMap);
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
