import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { formatBitableValue, buildFieldTypeMap } from "../../_lib/lark/field-types.js";
import { getSheetMeta, getSheetValues, batchUpdateValues, deleteRows } from "../../_lib/lark/sheets.js";
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

async function findLastUsedRowLark({ ssToken, sheetId, totalRows }){
  if(!totalRows) return 0;
  const colA = await getSheetValues({ ssToken, sheetId, range: `A1:A${totalRows}` });
  // Walk from the end so trailing blanks in the grid don't count.
  for(let i = (colA?.length || 0) - 1; i >= 0; i--){
    const v = colA[i]?.[0];
    if(v !== null && v !== undefined && String(v).trim() !== "") return i + 1;
  }
  return 0;
}

export async function syncLarkBaseToLarkSheet({ cfg, baseId, tableId, destUrl, viewId, rowFrom, rowTo, syncMode }){
  const items = await larkListAllRecords({ baseId, tableId, viewId });
  const sliced = items.slice((rowFrom || 1) - 1, rowTo || items.length);
  const limited = sliced.slice(0, cfg.maxRowsPerSync);
  const { headers, typeMap } = await resolveSchema({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: sliced.length > limited.length };
  }

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const endCol = endColumnFor(headers);
  const isAppend = syncMode === "append";

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);

  const dataRows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => formatBitableValue(fields[h], typeMap.get(h)));
  });

  let startRow;
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
    }
  } else {
    await batchUpdateValues({
      ssToken,
      ranges: [{ range: `${sheetId}!A1:${endCol}1`, values: [headers] }],
    });
    startRow = 2;
  }

  for(let i = 0; i < dataRows.length; i += cfg.sheetWriteChunk){
    const part = dataRows.slice(i, i + cfg.sheetWriteChunk);
    const s = startRow + i;
    await batchUpdateValues({
      ssToken,
      ranges: [{
        range: `${sheetId}!A${s}:${endCol}${s + part.length - 1}`,
        values: part,
      }],
    });
  }

  // Replace mode: shrink the sheet if the new dataset is smaller than the old grid.
  if(!isAppend){
    const newTotalRows = 1 + dataRows.length;
    if(oldRowCount > newTotalRows){
      try {
        await deleteRows({ ssToken, sheetId, startIndex: newTotalRows + 1, endIndex: oldRowCount });
      } catch(e){
        console.warn("[larkbase-to-larksheet] failed to trim excess rows:", e.message);
      }
    }
  }

  return { rowCount: dataRows.length, truncated: sliced.length > dataRows.length };
}
