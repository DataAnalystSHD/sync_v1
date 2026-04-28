import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { getSheetMeta, batchUpdateValues, deleteRows } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

function normalizeCell(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function collectHeadersFromRecords(items){
  const set = new Set();
  for(const it of items){
    for(const key of Object.keys(it.fields || {})) set.add(key);
  }
  return Array.from(set);
}

async function resolveHeaders({ baseId, tableId, items }){
  const fields = await larkListFields({ baseId, tableId });
  const ordered = fields.map(f => f.field_name).filter(Boolean);
  if(ordered.length > 0) return ordered;
  return collectHeadersFromRecords(items);
}

function readRowCount(meta){
  return Number(
    meta?.grid_properties?.row_count ||
    meta?.row_count ||
    meta?.rowCount ||
    0
  );
}

export async function syncLarkBaseToLarkSheet({ cfg, baseId, tableId, destUrl }){
  const items = await larkListAllRecords({ baseId, tableId });
  const limited = items.slice(0, cfg.maxRowsPerSync);
  const headers = await resolveHeaders({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: items.length > limited.length };
  }

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const endCol = endColumnFor(headers);

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);

  const dataRows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => normalizeCell(fields[h]));
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
