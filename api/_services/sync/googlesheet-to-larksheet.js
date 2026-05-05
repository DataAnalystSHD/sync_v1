import { sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { getSheetMeta, batchUpdateValues, deleteRows } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

function isEmptyCell(v){
  if(v === null || v === undefined) return true;
  if(typeof v === "string") return v.trim() === "";
  return false;
}

function isEmptyRow(row){
  if(!row || row.length === 0) return true;
  return row.every(isEmptyCell);
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

export async function syncGoogleSheetToLarkSheet({ accessToken, cfg, srcSheetId, srcGid, destUrl }){
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
  const dataValues = await sheetsGetValues({
    accessToken, spreadsheetId: srcSheetId,
    range: `${tab}A2:${endCol}`,
  });
  const dataRows = (dataValues || [])
    .filter(r => !isEmptyRow(r))
    .map(r => headers.map((_, i) => cellToString(r[i])));

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);

  await batchUpdateValues({
    ssToken,
    ranges: [{ range: `${sheetId}!A1:${endCol}1`, values: [headers] }],
  });

  for(let i = 0; i < dataRows.length; i += cfg.sheetWriteChunk){
    const part = dataRows.slice(i, i + cfg.sheetWriteChunk);
    const startRow = 2 + i;
    await batchUpdateValues({
      ssToken,
      ranges: [{
        range: `${sheetId}!A${startRow}:${endCol}${startRow + part.length - 1}`,
        values: part,
      }],
    });
  }

  const newTotalRows = 1 + dataRows.length;
  if(oldRowCount > newTotalRows){
    try {
      await deleteRows({ ssToken, sheetId, startIndex: newTotalRows + 1, endIndex: oldRowCount });
    } catch(e){
      console.warn("[googlesheet-to-larksheet] failed to trim excess rows:", e.message);
    }
  }

  return { rowCount: dataRows.length, truncated: false };
}
