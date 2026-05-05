import { getSheetValues, getSheetMeta, cellTextValue } from "../../_lib/lark/sheets.js";
import { sheetsClear, sheetsUpdate, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
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

async function readAllRows({ ssToken, sheetId, endCol, totalRows }){
  const out = [];
  for(let start = 1; start <= totalRows; start += READ_CHUNK){
    const end = Math.min(start + READ_CHUNK - 1, totalRows);
    const range = `A${start}:${endCol}${end}`;
    const chunk = await getSheetValues({ ssToken, sheetId, range });
    if(!chunk || chunk.length === 0) break;
    out.push(...chunk);
    if(chunk.length < (end - start + 1)) break;
  }
  return out;
}

export async function syncLarkSheetToGoogleSheet({ accessToken, cfg, sourceUrl, destSheetId, destGid }){
  const { ssToken, sheetId } = await resolveLarkSheetTarget(sourceUrl);

  const meta = await getSheetMeta({ ssToken, sheetId });
  const { rows: totalRows, cols: totalCols } = readGridSize(meta);
  if(totalRows === 0 || totalCols === 0){
    return { rowCount: 0, truncated: false };
  }

  const headerRange = `A1:${endColumnFor(new Array(Math.max(totalCols, 1)).fill(""))}1`;
  const headerRows = await getSheetValues({ ssToken, sheetId, range: headerRange });
  const rawHeaders = (headerRows?.[0] || []).map(cellTextValue);
  const headers = [];
  for(let i = 0; i < rawHeaders.length; i++){
    const h = rawHeaders[i].trim();
    if(h === "") break;
    headers.push(h);
  }
  if(headers.length === 0) throw new Error("Lark Sheet has no header row (row 1 must contain headers)");

  const endCol = endColumnFor(headers);
  const allRows = await readAllRows({ ssToken, sheetId, endCol, totalRows });
  const dataRows = allRows.slice(1)
    .filter(r => !isEmptyRow(r))
    .map(r => headers.map((_, i) => cellTextValue(r[i])));

  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: destSheetId, gid: destGid });
  const tab = `${quoteSheetName(tabName)}!`;

  await sheetsClear({ accessToken, spreadsheetId: destSheetId, range: `${tab}A:ZZ` });
  await sheetsUpdate({ accessToken, spreadsheetId: destSheetId, range: `${tab}A1:${endCol}1`, values: [headers] });

  for(let i = 0; i < dataRows.length; i += cfg.sheetWriteChunk){
    const part = dataRows.slice(i, i + cfg.sheetWriteChunk);
    const startRow = 2 + i;
    const range = `${tab}A${startRow}:${endCol}${startRow + part.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: destSheetId, range, values: part });
  }

  return { rowCount: dataRows.length, truncated: false };
}
