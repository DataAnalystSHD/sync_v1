import { sheetsClear, sheetsUpdate } from "../../_lib/google/sheets.js";
import { larkListAllRecords } from "../../_lib/lark/records.js";
import { endColumnFor } from "../../_lib/urls.js";

function normalizeCell(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function collectHeaders(items){
  const set = new Set();
  for(const it of items){
    for(const key of Object.keys(it.fields || {})) set.add(key);
  }
  return Array.from(set);
}

export async function syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId }){
  const items = await larkListAllRecords({ baseId, tableId });
  const limited = items.slice(0, cfg.maxRowsPerSync);
  const headers = collectHeaders(limited);

  if(headers.length === 0){
    return { rowCount: 0, truncated: items.length > limited.length };
  }

  const endCol = endColumnFor(headers);

  await sheetsClear({ accessToken, spreadsheetId: sheetId, range: `A1:${endCol}` });
  await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range: `A1:${endCol}1`, values: [headers] });

  const rows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => normalizeCell(fields[h]));
  });

  for(let i = 0; i < rows.length; i += cfg.sheetWriteChunk){
    const part = rows.slice(i, i + cfg.sheetWriteChunk);
    const startRow = 2 + i;
    const range = `A${startRow}:${endCol}${startRow + part.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range, values: part });
  }

  return { rowCount: rows.length, truncated: items.length > rows.length };
}
