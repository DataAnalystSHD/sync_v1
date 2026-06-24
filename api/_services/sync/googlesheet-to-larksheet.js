import { sheetsGetValues, sheetsGetGrid, cellLink, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { getSheetMeta, getSheetValues, batchUpdateValues, deleteRows } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

function isEmptyCell(v){
  if(v === null || v === undefined) return true;
  if(typeof v === "string") return v.trim() === "";
  return false; // hyperlink object => not empty
}

function isEmptyRow(row){
  if(!row || row.length === 0) return true;
  return row.every(isEmptyCell);
}

// Build the value written to one Lark cell. When the source cell carries a link
// we emit Lark's hyperlink form ({type:"url", text, link}) so the link survives
// the sync; otherwise a plain string, matching the old behaviour.
function cellToLark(cell){
  const text = cell?.formattedValue ?? "";
  const link = cellLink(cell);
  if(link) return { type: "url", text: String(text), link };
  return String(text);
}

function cellToString(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function readRowCount(meta){
  return Number(
    meta?.grid_properties?.row_count ||
    meta?.row_count ||
    meta?.rowCount ||
    0
  );
}

async function findLastUsedRowLark({ ssToken, sheetId, totalRows }){
  if(!totalRows) return 0;
  const colA = await getSheetValues({ ssToken, sheetId, range: `A1:A${totalRows}` });
  for(let i = (colA?.length || 0) - 1; i >= 0; i--){
    const v = colA[i]?.[0];
    if(v !== null && v !== undefined && String(v).trim() !== "") return i + 1;
  }
  return 0;
}

export async function syncGoogleSheetToLarkSheet({ accessToken, cfg, srcSheetId, srcGid, destUrl, rowFrom, rowTo, syncMode }){
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: srcSheetId, gid: srcGid });
  const tab = `${quoteSheetName(tabName)}!`;

  const headerRow = await sheetsGetValues({ accessToken, spreadsheetId: srcSheetId, range: `${tab}A1:1` });
  const rawHeaders = (headerRow?.[0] || []).map(cellToString);
  const headers = [];
  for(let i = 0; i < rawHeaders.length; i++){
    const h = rawHeaders[i].trim();
    if(h === "") break;
    headers.push(h);
  }
  if(headers.length === 0) throw new Error("Google Sheet has no header row (row 1 must contain headers)");

  const endCol = endColumnFor(headers);
  // Data rows (1-indexed, excludes header) → sheet rows (header at 1, data 2+).
  const dataStartSheetRow = (rowFrom || 1) + 1;
  const dataRange = rowTo
    ? `${tab}A${dataStartSheetRow}:${endCol}${rowTo + 1}`
    : `${tab}A${dataStartSheetRow}:${endCol}`;
  // Grid data (not /values) so embedded hyperlinks in cells are preserved.
  const grid = await sheetsGetGrid({
    accessToken, spreadsheetId: srcSheetId,
    range: dataRange,
  });
  const dataRows = grid
    .map(row => headers.map((_, i) => cellToLark(row[i])))
    .filter(r => !isEmptyRow(r));

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const isAppend = syncMode === "append";

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);

  let startRow;
  let appendSkip = 0;   // data rows the destination already holds (append only the rest)
  if(isAppend){
    const lastRow = await findLastUsedRowLark({ ssToken, sheetId, totalRows: oldRowCount });
    if(lastRow === 0){
      await batchUpdateValues({
        ssToken,
        ranges: [{ range: `${sheetId}!A1:${endCol}1`, values: [headers] }],
      });
      startRow = 2;
    } else {
      startRow = lastRow + 1;
      appendSkip = lastRow - 1;
    }
  } else {
    await batchUpdateValues({
      ssToken,
      ranges: [{ range: `${sheetId}!A1:${endCol}1`, values: [headers] }],
    });
    startRow = 2;
  }

  // Append mode: only the source rows beyond what the destination already holds.
  const writeRows = isAppend ? dataRows.slice(appendSkip) : dataRows;

  for(let i = 0; i < writeRows.length; i += cfg.sheetWriteChunk){
    const part = writeRows.slice(i, i + cfg.sheetWriteChunk);
    const s = startRow + i;
    await batchUpdateValues({
      ssToken,
      ranges: [{
        range: `${sheetId}!A${s}:${endCol}${s + part.length - 1}`,
        values: part,
      }],
    });
  }

  if(!isAppend){
    const newTotalRows = 1 + dataRows.length;
    if(oldRowCount > newTotalRows){
      try {
        await deleteRows({ ssToken, sheetId, startIndex: newTotalRows + 1, endIndex: oldRowCount });
      } catch(e){
        console.warn("[googlesheet-to-larksheet] failed to trim excess rows:", e.message);
      }
    }
  }

  return { rowCount: writeRows.length, truncated: false };
}
