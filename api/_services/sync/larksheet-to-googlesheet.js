import { getSheetValues, getSheetMeta, cellTextValue } from "../../_lib/lark/sheets.js";
import { sheetsClear, sheetsUpdate, sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

const READ_CHUNK = 5000;

function isEmptyRow(row){
  if(!row || row.length === 0) return true;
  return row.every(v => cellTextValue(v).trim() === "");
}

function readGridSize(meta){
  const rows = Number(meta?.grid_properties?.row_count || meta?.row_count || 0);
  const cols = Number(meta?.grid_properties?.column_count || meta?.column_count || 0);
  return { rows, cols };
}

async function readRowsInRange({ ssToken, sheetId, endCol, startRow, endRow }){
  const out = [];
  for(let s = startRow; s <= endRow; s += READ_CHUNK){
    const e = Math.min(s + READ_CHUNK - 1, endRow);
    const range = `A${s}:${endCol}${e}`;
    const chunk = await getSheetValues({ ssToken, sheetId, range });
    if(!chunk || chunk.length === 0) break;
    out.push(...chunk);
    if(chunk.length < (e - s + 1)) break;
  }
  return out;
}

async function findLastUsedRowGoogle({ accessToken, spreadsheetId, tab }){
  const colA = await sheetsGetValues({ accessToken, spreadsheetId, range: `${tab}A:A` });
  return (colA || []).length;
}

export async function syncLarkSheetToGoogleSheet({ accessToken, cfg, sourceUrl, destSheetId, destGid, rowFrom, rowTo, syncMode, columns, noHeader }){
  const { ssToken, sheetId } = await resolveLarkSheetTarget(sourceUrl);

  const meta = await getSheetMeta({ ssToken, sheetId });
  const { rows: totalRows, cols: totalCols } = readGridSize(meta);
  if(totalRows === 0 || totalCols === 0){
    return { rowCount: 0, truncated: false };
  }

  let headers, endCol, dataRows;

  if(noHeader){
    // No header row: every row is data, columns labelled Column 1..N.
    headers = Array.from({ length: totalCols }, (_, i) => `Column ${i + 1}`);
    endCol = endColumnFor(headers);
    const startRow = rowFrom || 1;
    const endRow = Math.min(totalRows, rowTo || totalRows);
    const rangeRows = endRow >= startRow
      ? await readRowsInRange({ ssToken, sheetId, endCol, startRow, endRow })
      : [];
    dataRows = rangeRows
      .filter(r => !isEmptyRow(r))
      .map(r => headers.map((_, i) => cellTextValue(r[i])));
  } else {
    const headerRange = `A1:${endColumnFor(new Array(Math.max(totalCols, 1)).fill(""))}1`;
    const headerRows = await getSheetValues({ ssToken, sheetId, range: headerRange });
    const rawHeaders = (headerRows?.[0] || []).map(cellTextValue);
    const fullHeaders = [];
    for(let i = 0; i < rawHeaders.length; i++){
      const h = rawHeaders[i].trim();
      if(h === "") break;
      fullHeaders.push(h);
    }
    if(fullHeaders.length === 0) throw new Error('Lark Sheet has no header row (row 1 must contain headers). ถ้าแถวแรกไม่ใช่หัวคอลัมน์ ให้ติ๊ก "แถวแรกไม่มีหัวคอลัมน์"');

    // Column selection (empty = all). Read the source at full width so cell
    // indices line up, then project each row down to the chosen columns.
    let indices;
    ({ headers, indices } = selectColumns(fullHeaders, columns));
    const readEndCol = endColumnFor(fullHeaders);   // source read width
    endCol = endColumnFor(headers);                 // destination write width
    // Translate user-facing data rows (1-indexed, excludes header) to sheet rows
    // (header is row 1, data starts at row 2). Cap to grid extent.
    const dataStartSheetRow = (rowFrom || 1) + 1;
    const dataEndSheetRow   = Math.min(totalRows, rowTo ? (rowTo + 1) : totalRows);
    const rangeRows = dataEndSheetRow >= dataStartSheetRow
      ? await readRowsInRange({ ssToken, sheetId, endCol: readEndCol, startRow: dataStartSheetRow, endRow: dataEndSheetRow })
      : [];
    dataRows = rangeRows
      .filter(r => !isEmptyRow(r))
      .map(r => indices.map(i => cellTextValue(r[i])));
  }

  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: destSheetId, gid: destGid });
  const tab = `${quoteSheetName(tabName)}!`;
  const isAppend = syncMode === "append";

  let startRow;
  let appendSkip = 0;   // data rows the destination already holds (append only the rest)
  if(isAppend){
    const lastRow = await findLastUsedRowGoogle({ accessToken, spreadsheetId: destSheetId, tab });
    if(lastRow === 0){
      await sheetsUpdate({ accessToken, spreadsheetId: destSheetId, range: `${tab}A1:${endCol}1`, values: [headers] });
      startRow = 2;
    } else {
      startRow = lastRow + 1;
      appendSkip = lastRow - 1;
    }
  } else {
    await sheetsClear({ accessToken, spreadsheetId: destSheetId, range: `${tab}A:ZZ` });
    await sheetsUpdate({ accessToken, spreadsheetId: destSheetId, range: `${tab}A1:${endCol}1`, values: [headers] });
    startRow = 2;
  }

  // Append mode: only the source rows beyond what the destination already holds.
  const writeRows = isAppend ? dataRows.slice(appendSkip) : dataRows;

  for(let i = 0; i < writeRows.length; i += cfg.sheetWriteChunk){
    const part = writeRows.slice(i, i + cfg.sheetWriteChunk);
    const s = startRow + i;
    const range = `${tab}A${s}:${endCol}${s + part.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: destSheetId, range, values: part });
  }

  return { rowCount: writeRows.length, truncated: false };
}
