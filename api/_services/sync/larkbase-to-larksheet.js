import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { buildFieldTypeMap, bitableCellToLarkSheet } from "../../_lib/lark/field-types.js";
import { getSheetMeta, getSheetValues, batchUpdateBanded, deleteRows, deleteColumns } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
import { applyRecordFilters } from "../../_lib/filters.js";
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

export async function syncLarkBaseToLarkSheet({ cfg, baseId, tableId, destUrl, viewId, rowFrom, rowTo, syncMode, columns, filters }){
  let items = await larkListAllRecords({ baseId, tableId, viewId });
  // Value filter (empty = all rows) — applied before Row Range slicing.
  if(Array.isArray(filters) && filters.length){
    const fmap = buildFieldTypeMap(await larkListFields({ baseId, tableId }));
    items = applyRecordFilters(items, filters, fmap);
  }
  const sliced = items.slice((rowFrom || 1) - 1, rowTo || items.length);
  const limited = sliced.slice(0, cfg.maxRowsPerSync);
  let { headers, typeMap } = await resolveSchema({ baseId, tableId, items: limited });

  if(headers.length === 0){
    return { rowCount: 0, truncated: sliced.length > limited.length };
  }
  // Column selection (empty = all). Row map below is header-name-keyed.
  headers = selectColumns(headers, columns).headers;

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const endCol = endColumnFor(headers);
  const isAppend = syncMode === "append";

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);
  const oldColCount = Number(meta?.grid_properties?.column_count || 0);

  const dataRows = limited.map(it => {
    const fields = it.fields || {};
    // Preserve attached hyperlinks (URL fields / linked text) into the Lark Sheet.
    return headers.map(h => bitableCellToLarkSheet(fields[h], typeMap.get(h)));
  });

  let startRow;
  let appendSkip = 0;   // data rows the destination already holds (append only the rest)
  if(isAppend){
    const lastRow = await findLastUsedRowLark({ ssToken, sheetId, totalRows: oldRowCount });
    if(lastRow === 0){
      await batchUpdateBanded({ ssToken, sheetId, startRow: 1, rows: [headers] });
      startRow = 2;
    } else {
      startRow = lastRow + 1;
      appendSkip = lastRow - 1;
    }
  } else {
    await batchUpdateBanded({ ssToken, sheetId, startRow: 1, rows: [headers] });
    startRow = 2;
  }

  // Append mode: only the source rows beyond what the destination already holds.
  const writeRows = isAppend ? dataRows.slice(appendSkip) : dataRows;

  // Lark caps a write at 100 columns — batchUpdateBanded splits wide data.
  await batchUpdateBanded({ ssToken, sheetId, startRow, rows: writeRows, rowChunk: cfg.sheetWriteChunk });

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
    // Trim stale columns too — e.g. after column selection narrows 47 → 3, the
    // old columns to the right must be removed (Replace should leave ONLY the
    // written columns).
    if(oldColCount > headers.length){
      try {
        await deleteColumns({ ssToken, sheetId, startIndex: headers.length + 1, endIndex: oldColCount });
      } catch(e){
        console.warn("[larkbase-to-larksheet] failed to trim excess columns:", e.message);
      }
    }
  }

  return { rowCount: writeRows.length, truncated: sliced.length > limited.length };
}
