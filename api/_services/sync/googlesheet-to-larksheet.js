import { sheetsGetValues, sheetsGetGrid, cellLink, getSheetNameByGid, quoteSheetName } from "../../_lib/google/sheets.js";
import { getSheetMeta, getSheetValues, batchUpdateBanded, deleteRows, deleteColumns } from "../../_lib/lark/sheets.js";
import { endColumnFor } from "../../_lib/urls.js";
import { selectColumns } from "../../_lib/columns.js";
import { resolveLarkSheetTarget } from "./lark-sheet-target.js";

function isEmptyCell(v){
  if(v === null || v === undefined) return true;
  if(typeof v === "string") return v.trim() === "";
  return false; // hyperlink object => not empty
}

function isEmptyRow(row){
  if(!row || row.length === 0) return true;
  return row.every(isEmptyCell);
}

// Build the value written to one Lark cell. When the source cell carries a link
// we emit Lark's hyperlink form ({type:"url", text, link}) so the link survives
// the sync; otherwise a plain string, matching the old behaviour.
function cellToLark(cell){
  const text = cell?.formattedValue ?? "";
  const link = cellLink(cell);
  if(link) return { type: "url", text: String(text), link };
  return String(text);
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

async function findLastUsedRowLark({ ssToken, sheetId, totalRows }){
  if(!totalRows) return 0;
  const colA = await getSheetValues({ ssToken, sheetId, range: `A1:A${totalRows}` });
  for(let i = (colA?.length || 0) - 1; i >= 0; i--){
    const v = colA[i]?.[0];
    if(v !== null && v !== undefined && String(v).trim() !== "") return i + 1;
  }
  return 0;
}

export async function syncGoogleSheetToLarkSheet({ accessToken, cfg, srcSheetId, srcGid, destUrl, rowFrom, rowTo, syncMode, columns, noHeader }){
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: srcSheetId, gid: srcGid });
  const tab = `${quoteSheetName(tabName)}!`;

  let headers, endCol, dataRows;

  if(noHeader){
    // No header row: read EVERY row (row 1 = data) and label columns Column 1..N.
    const startSheetRow = rowFrom || 1;
    const range = rowTo ? `${tab}A${startSheetRow}:CZ${rowTo}` : `${tab}A${startSheetRow}:CZ`;
    const grid = await sheetsGetGrid({ accessToken, spreadsheetId: srcSheetId, range });
    // Width = last column that holds real DATA (text or a link). Cells that only
    // carry formatting (e.g. a black/red title bar) are ignored so the write
    // range doesn't balloon past the destination sheet (Lark RangeVal fail).
    let width = 0;
    for(const row of (grid || [])){
      const r = row || [];
      for(let i = r.length - 1; i >= 0; i--){
        const c = r[i];
        if((c?.formattedValue ?? "") !== "" || cellLink(c)){ if(i + 1 > width) width = i + 1; break; }
      }
    }
    if(width === 0) return { rowCount: 0, truncated: false };
    headers = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    endCol = endColumnFor(headers);
    dataRows = grid
      .map(row => headers.map((_, i) => cellToLark(row[i])))
      .filter(r => !isEmptyRow(r));
  } else {
    const headerRow = await sheetsGetValues({ accessToken, spreadsheetId: srcSheetId, range: `${tab}A1:1` });
    const rawHeaders = (headerRow?.[0] || []).map(cellToString);
    const fullHeaders = [];
    for(let i = 0; i < rawHeaders.length; i++){
      const h = rawHeaders[i].trim();
      if(h === "") break;
      fullHeaders.push(h);
    }
    if(fullHeaders.length === 0) throw new Error('Google Sheet has no header row (row 1 must contain headers). ถ้าแถวแรกไม่ใช่หัวคอลัมน์ ให้ติ๊ก "แถวแรกไม่มีหัวคอลัมน์"');

    // Column selection (empty = all). Read the source at full width, then project
    // each row down to the chosen columns.
    let indices;
    ({ headers, indices } = selectColumns(fullHeaders, columns));
    const readEndCol = endColumnFor(fullHeaders);   // source read width
    endCol = endColumnFor(headers);                 // destination write width
    // Data rows (1-indexed, excludes header) → sheet rows (header at 1, data 2+).
    const dataStartSheetRow = (rowFrom || 1) + 1;
    const dataRange = rowTo
      ? `${tab}A${dataStartSheetRow}:${readEndCol}${rowTo + 1}`
      : `${tab}A${dataStartSheetRow}:${readEndCol}`;
    // Grid data (not /values) so embedded hyperlinks in cells are preserved.
    const grid = await sheetsGetGrid({ accessToken, spreadsheetId: srcSheetId, range: dataRange });
    dataRows = grid
      .map(row => indices.map(i => cellToLark(row[i])))
      .filter(r => !isEmptyRow(r));
  }

  const { ssToken, sheetId } = await resolveLarkSheetTarget(destUrl);
  const isAppend = syncMode === "append";

  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldRowCount = readRowCount(meta);
  const oldColCount = Number(meta?.grid_properties?.column_count || 0);

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

  if(!isAppend){
    const newTotalRows = 1 + dataRows.length;
    if(oldRowCount > newTotalRows){
      try {
        await deleteRows({ ssToken, sheetId, startIndex: newTotalRows + 1, endIndex: oldRowCount });
      } catch(e){
        console.warn("[googlesheet-to-larksheet] failed to trim excess rows:", e.message);
      }
    }
    if(oldColCount > headers.length){
      try {
        await deleteColumns({ ssToken, sheetId, startIndex: headers.length + 1, endIndex: oldColCount });
      } catch(e){
        console.warn("[googlesheet-to-larksheet] failed to trim excess columns:", e.message);
      }
    }
  }

  return { rowCount: writeRows.length, truncated: false };
}
