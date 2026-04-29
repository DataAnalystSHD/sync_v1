import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { formatBitableValue, buildFieldTypeMap } from "../../_lib/lark/field-types.js";
import { getSheetMeta, batchUpdateValues, deleteRows } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

function collectHeadersFromRecords(items){
  const set = new Set();
  for(const it of items){
    for(const key of Object.keys(it.fields || {})) set.add(key);
  }
  return Array.from(set);
}

async function resolveSchema({ baseId, tableId, items }){
  const fields = await larkListFields({ baseId, tableId });
  const headers = fields.map(f => f.field_name).filter(Boolean);
  if(headers.length > 0){
    return { headers, typeMap: buildFieldTypeMap(fields) };
  }
  return { headers: collectHeadersFromRecords(items), typeMap: new Map() };
}

function readRowCount(meta){
  return Number(
    meta?.grid_properties?.row_count ||
    meta?.row_count ||
    meta?.rowCount ||
    0
  );
}

export async function syncLarkBaseToLarkSheet({ cfg, baseId, tableId, destUrl, viewId }){
  const items = await larkListAllRecords({ baseId, tableId, viewId });
  const limited = items.slice(0, cfg.maxRowsPerSync);
  const { headers, typeMap } = await resolveSchema({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: items.length > limited.length };
  }

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const endCol = endColumnFor(headers);

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);

  const dataRows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => formatBitableValue(fields[h], typeMap.get(h)));
  });
  const newTotalRows = 1 + dataRows.length;

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

  if(oldRowCount > newTotalRows){
    try {
      await deleteRows({ ssToken, sheetId, startIndex: newTotalRows + 1, endIndex: oldRowCount });
    } catch(e){
      console.warn("[larkbase-to-larksheet] failed to trim excess rows:", e.message);
    }
  }

  return { rowCount: dataRows.length, truncated: items.length > dataRows.length };
}
