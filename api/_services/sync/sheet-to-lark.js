import { sheetsGetValues, sheetsGetGrid, cellLink, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { larkBatchDeleteAll, larkCreateRecordsBatched, larkCountRecords } from "../../_lib/lark/records.js";
import { larkEnsureFields, larkListFields, larkDeleteField } from "../../_lib/lark/fields.js";
import { inferType, inferProperty, convertForLark } from "../../_lib/lark/infer-types.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
import { updateCursor, updatePhase } from "../pairs-store.js";

const PHASE_RUNNING = "sheet2lark_running";
const PHASE_IDLE    = "idle";
const INFER_SAMPLE_ROWS = 100;
const URL_TYPE  = 15;    // Lark Bitable URL field — the only field that stores a hyperlink
const GRID_CHUNK = 2000; // read grid metadata in small chunks (a huge single grid read times out)

// Grid cells are objects ({formattedValue, hyperlink, ...}); tolerate plain strings too.
const cellText = (c) => (c && typeof c === "object") ? (c.formattedValue ?? "") : String(c ?? "");
const linkOf   = (c) => (c && typeof c === "object") ? (cellLink(c) || "") : "";

// Read a row range as GRID (cell objects, so hyperlinks are visible), chunked to
// avoid oversized responses. If a grid chunk fails, fall back to plain values for
// that chunk (data is preserved; only its links are lost).
async function readGridRows({ accessToken, sheetId, tab, startRow, endRow, endCol }){
  const out = [];
  for(let s = startRow; s <= endRow; s += GRID_CHUNK){
    const e = Math.min(s + GRID_CHUNK - 1, endRow);
    const range = `${tab}A${s}:${endCol}${e}`;
    let chunk;
    try { chunk = await sheetsGetGrid({ accessToken, spreadsheetId: sheetId, range }); }
    catch { chunk = null; }
    if(chunk == null){
      const plain = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });
      if(!plain || plain.length === 0) break;
      out.push(...plain);
      if(plain.length < (e - s + 1)) break;
      continue;
    }
    if(chunk.length === 0) break;
    out.push(...chunk);
    if(chunk.length < (e - s + 1)) break;
  }
  return out;
}

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
  // Sample as GRID so we can see which columns carry hyperlinks; that sample is
  // small (≤100 rows) so a single grid read is safe. Fall back to plain values
  // (no link detection) if the grid read fails.
  let grid = null;
  try { grid = await sheetsGetGrid({ accessToken, spreadsheetId: sheetId, range }); }
  catch { grid = null; }
  if(grid == null){
    const rows = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });
    return headers.map((name, i) => {
      const samples = (rows || []).map(r => r[i]);
      const type = inferType(samples);
      return { name, type, property: inferProperty(samples, type) };
    });
  }
  return headers.map((name, i) => {
    const cells = (grid || []).map(r => r[i]);
    // A column with any linked cell becomes a Lark URL field (the only field type
    // that can store a clickable link, incl. links embedded inside the text).
    if(cells.some(c => linkOf(c) !== "")) return { name, type: URL_TYPE };
    const samples = cells.map(cellText);
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
  // A link-bearing column must be a URL field (type 15). If one already exists as
  // another type it can't hold links — on Replace (rows get wiped anyway) drop it
  // so larkEnsureFields recreates it as URL. Never touch fields on Append.
  if(syncMode !== "append"){
    const existing = await larkListFields({ baseId, tableId });
    const byNorm = new Map(existing.map(f => [String(f.field_name || "").trim().toLowerCase(), f]));
    for(const f of fields){
      if(f.type !== URL_TYPE) continue;
      const hit = byNorm.get(String(f.name).trim().toLowerCase());
      if(hit && hit.type !== URL_TYPE && hit.field_id){
        await larkDeleteField({ baseId, tableId, fieldId: hit.field_id });
      }
    }
  }
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

// rows may be grid cell objects (link-aware) or plain strings (fallback); the
// cellText/linkOf helpers tolerate both.
function rowsToRecords(rows, headers, typeMap, nameMap){
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, idx) => {
      const cell = row[idx];
      const type = typeMap.get(h) || 1;
      const key  = nameMap?.get(h) || h;
      if(type === URL_TYPE){
        const text = cellText(cell);
        if(text === "") return;                       // skip blanks (no empty URL cells)
        obj[key] = { text, link: linkOf(cell) || "" };  // empty link = plain text, accepted by Lark
        return;
      }
      const v = convertForLark(cellText(cell), type);
      if(v !== undefined) obj[key] = v;
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
    const values = await readGridRows({
      accessToken, sheetId, tab,
      startRow: startSheetRow, endRow: endSheetRow, endCol,
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
  const values = await readGridRows({
    accessToken, sheetId, tab,
    startRow: startSheetRow, endRow: endSheetRow, endCol,
  });

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
