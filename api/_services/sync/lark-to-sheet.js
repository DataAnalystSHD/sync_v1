import { sheetsClear, sheetsUpdate, sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { formatBitableValue, buildFieldTypeMap } from "../../_lib/lark/field-types.js";
import { endColumnFor } from "../../_lib/urls.js";

function collectHeadersFromRecords(items){
  const set = new Set();
  for(const it of items){
    for(const key of Object.keys(it.fields || {})) set.add(key);
  }
  return Array.from(set);
}

async function resolveSchema({ baseId, tableId, items }){
  // Lark's record.fields key order isn't guaranteed to match the table's
  // visual column order, so prefer the /fields endpoint which returns
  // fields in their actual column order — and gives us per-field types.
  const fields = await larkListFields({ baseId, tableId });
  const headers = fields.map(f => f.field_name).filter(Boolean);
  if(headers.length > 0){
    return { headers, typeMap: buildFieldTypeMap(fields) };
  }
  return { headers: collectHeadersFromRecords(items), typeMap: new Map() };
}

async function findLastUsedRowGoogle({ accessToken, spreadsheetId, tab }){
  const colA = await sheetsGetValues({ accessToken, spreadsheetId, range: `${tab}A:A` });
  return (colA || []).length;
}

export async function syncLarkToSheet({ accessToken, cfg, sheetId, gid, baseId, tableId, viewId, rowFrom, rowTo, syncMode }){
  const items = await larkListAllRecords({ baseId, tableId, viewId });
  const sliced = items.slice((rowFrom || 1) - 1, rowTo || items.length);
  const limited = sliced.slice(0, cfg.maxRowsPerSync);
  const { headers, typeMap } = await resolveSchema({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: sliced.length > limited.length };
  }

  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: sheetId, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const endCol = endColumnFor(headers);
  const isAppend = syncMode === "append";

  let startRow;
  if(isAppend){
    const lastRow = await findLastUsedRowGoogle({ accessToken, spreadsheetId: sheetId, tab });
    // If sheet is empty, treat as fresh: write headers at row 1, data from row 2.
    if(lastRow === 0){
      await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range: `${tab}A1:${endCol}1`, values: [headers] });
      startRow = 2;
    } else {
      startRow = lastRow + 1;
    }
  } else {
    // Replace: wipe the visible width so a shrunk schema doesn't leave stale columns.
    await sheetsClear({ accessToken, spreadsheetId: sheetId, range: `${tab}A:ZZ` });
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range: `${tab}A1:${endCol}1`, values: [headers] });
    startRow = 2;
  }

  const rows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => formatBitableValue(fields[h], typeMap.get(h)));
  });

  for(let i = 0; i < rows.length; i += cfg.sheetWriteChunk){
    const part = rows.slice(i, i + cfg.sheetWriteChunk);
    const start = startRow + i;
    const range = `${tab}A${start}:${endCol}${start + part.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range, values: part });
  }

  return { rowCount: rows.length, truncated: sliced.length > rows.length };
}
