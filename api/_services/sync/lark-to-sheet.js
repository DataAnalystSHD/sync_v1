import { sheetsClear, sheetsUpdate, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
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

export async function syncLarkToSheet({ accessToken, cfg, sheetId, gid, baseId, tableId, viewId }){
  const items = await larkListAllRecords({ baseId, tableId, viewId });
  const limited = items.slice(0, cfg.maxRowsPerSync);
  const { headers, typeMap } = await resolveSchema({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: items.length > limited.length };
  }

  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: sheetId, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const endCol = endColumnFor(headers);

  // Clear the full visible width so leftover columns from a previous schema
  // don't linger when the new Lark Base has fewer fields than the sheet.
  await sheetsClear({ accessToken, spreadsheetId: sheetId, range: `${tab}A:ZZ` });
  await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range: `${tab}A1:${endCol}1`, values: [headers] });

  const rows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => formatBitableValue(fields[h], typeMap.get(h)));
  });

  for(let i = 0; i < rows.length; i += cfg.sheetWriteChunk){
    const part = rows.slice(i, i + cfg.sheetWriteChunk);
    const startRow = 2 + i;
    const range = `${tab}A${startRow}:${endCol}${startRow + part.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range, values: part });
  }

  return { rowCount: rows.length, truncated: items.length > rows.length };
}
