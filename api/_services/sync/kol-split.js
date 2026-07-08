// KOL split sync: read the Lark Base "KOL 2026 Copy" table and rebuild two Lark
// Sheet tabs, splitting rows by the Promote Method column.
//   New KOL -> NEW tab      Old KOL -> OLD tab      blank/other -> skipped
// Both tabs are rebuilt each run: header (all Base columns) at row 1, data from
// row 2, leftover rows trimmed. Idempotent — safe to run on a schedule.
//
// Config (all overridable via env so the IDs aren't locked in code):
//   KOL_SPLIT_BASE_ID / KOL_SPLIT_TABLE_ID / KOL_SPLIT_VIEW_ID
//   KOL_SPLIT_WIKI_TOKEN / KOL_SPLIT_NEW_SHEET / KOL_SPLIT_OLD_SHEET
import { larkListAllRecords } from "../../_lib/lark/records.js";
import { larkListFields } from "../../_lib/lark/fields.js";
import { formatBitableValue, buildFieldTypeMap } from "../../_lib/lark/field-types.js";
import { getSheetMeta, getSheetValues, batchUpdateValues, deleteRows, cellTextValue } from "../../_lib/lark/sheets.js";
import { resolveWikiNode } from "../../_lib/lark/wiki.js";
import { endColumnFor } from "../../_lib/urls.js";
import { getConfig } from "../../_lib/config.js";

const CONF = {
  baseId:    process.env.KOL_SPLIT_BASE_ID    || "F8pGb3xbhahlQvsnGwZcRVfanzh",
  tableId:   process.env.KOL_SPLIT_TABLE_ID   || "tblYcRghvSyxx8ik",
  viewId:    process.env.KOL_SPLIT_VIEW_ID    || "vewf7lG6fU",
  wikiToken: process.env.KOL_SPLIT_WIKI_TOKEN || "B0thw6Lo9i8PMnkPlgoci3lOnre",
  newSheet:  process.env.KOL_SPLIT_NEW_SHEET  || "ZvXhDy",   // New KOL Performence
  oldSheet:  process.env.KOL_SPLIT_OLD_SHEET  || "s8GBQA",   // Old KOL Performence
};

const norm = (s) => String(s ?? "").trim().toLowerCase();

async function resolveSpreadsheetToken(wikiToken){
  const { objToken, objType } = await resolveWikiNode(wikiToken);
  if(!objToken) throw new Error("Wiki node has no underlying object");
  if(objType !== "sheet") throw new Error(`Wiki node type=${objType}, expected sheet`);
  return objToken;
}

function readRowCount(meta){
  return Number(meta?.grid_properties?.row_count || meta?.row_count || meta?.rowCount || 0);
}

async function findLastUsedRow({ ssToken, sheetId, totalRows }){
  if(!totalRows) return 0;
  const colA = await getSheetValues({ ssToken, sheetId, range: `A1:A${totalRows}` });
  for(let i = (colA?.length || 0) - 1; i >= 0; i--){
    const v = colA[i]?.[0];
    if(v !== null && v !== undefined && String(v).trim() !== "") return i + 1;
  }
  return 0;
}

// Rebuild a tab: header at row 1, data from row 2, then trim leftover old rows.
async function rebuildTab({ ssToken, sheetId, headers, dataRows, chunk, dryRun, log }){
  const endCol = endColumnFor(headers);
  const meta = await getSheetMeta({ ssToken, sheetId });
  const oldLastRow = await findLastUsedRow({ ssToken, sheetId, totalRows: readRowCount(meta) });
  const newLastRow = 1 + dataRows.length;
  log?.(`[${sheetId}] old last row=${oldLastRow}, writing ${dataRows.length} rows`);

  if(dryRun) return;

  await batchUpdateValues({ ssToken, ranges: [{ range: `${sheetId}!A1:${endCol}1`, values: [headers] }] });
  for(let i = 0; i < dataRows.length; i += chunk){
    const part = dataRows.slice(i, i + chunk);
    const s = 2 + i;
    await batchUpdateValues({
      ssToken,
      ranges: [{ range: `${sheetId}!A${s}:${endCol}${s + part.length - 1}`, values: part }],
    });
  }
  if(oldLastRow > newLastRow){
    await deleteRows({ ssToken, sheetId, startIndex: newLastRow + 1, endIndex: oldLastRow });
  }
}

// Change detection without any extra storage: read the tab's current data and
// compare it, cell-for-cell, against what we would write. Round-trips exactly
// (values we write come back identical via cellTextValue), so a match means the
// tab is already up to date. Errs toward "changed" on any read hiccup, so it may
// rewrite unnecessarily but never leaves the tab stale.
async function tabMatches({ ssToken, sheetId, headers, dataRows }){
  const endCol = endColumnFor(headers);
  const meta = await getSheetMeta({ ssToken, sheetId });
  const lastRow = await findLastUsedRow({ ssToken, sheetId, totalRows: readRowCount(meta) });
  if(lastRow !== dataRows.length + 1) return false;   // row count differs (header + data)
  if(dataRows.length === 0) return true;

  const grid = await getSheetValues({ ssToken, sheetId, range: `A2:${endCol}${1 + dataRows.length}` });
  for(let i = 0; i < dataRows.length; i++){
    const want = dataRows[i];
    const got = grid[i] || [];
    for(let j = 0; j < headers.length; j++){
      if(String(want[j] ?? "") !== cellTextValue(got[j])) return false;
    }
  }
  return true;
}

/**
 * Run the KOL split. Returns { newCount, oldCount, skipped, columns, changed }.
 *   dryRun: read + classify, never write.
 *   force:  rewrite both tabs even if they already match (skip the change check).
 * When both tabs already hold the current split, they're left untouched and
 * `changed` is false — cheap enough to call on a frequent poll.
 */
export async function runKolSplit({ dryRun = false, force = false, log } = {}){
  const cfg = getConfig();
  const { baseId, tableId, viewId, wikiToken, newSheet, oldSheet } = CONF;

  const items = await larkListAllRecords({ baseId, tableId, viewId });
  const fields = await larkListFields({ baseId, tableId });
  const headers = fields.map((f) => f.field_name).filter(Boolean);
  if(headers.length === 0) throw new Error("Source table has no fields");
  const typeMap = buildFieldTypeMap(fields);

  const promoteKey = headers.find((h) => /promote/i.test(h));
  if(!promoteKey) throw new Error("No Promote Method column found on source table");

  const mapRow = (f) => headers.map((h) => formatBitableValue(f[h], typeMap.get(h)));
  const newRows = [];
  const oldRows = [];
  let skipped = 0;
  for(const it of items){
    const f = it.fields || {};
    const pm = norm(formatBitableValue(f[promoteKey], typeMap.get(promoteKey)));
    if(pm === "new kol") newRows.push(mapRow(f));
    else if(pm === "old kol") oldRows.push(mapRow(f));
    else skipped++;
  }
  const base = { newCount: newRows.length, oldCount: oldRows.length, skipped, columns: headers.length, dryRun };
  log?.(`records=${items.length} new=${newRows.length} old=${oldRows.length} skipped=${skipped}`);

  const ssToken = await resolveSpreadsheetToken(wikiToken);

  if(!dryRun && !force){
    const matches = await tabMatches({ ssToken, sheetId: newSheet, headers, dataRows: newRows })
                 && await tabMatches({ ssToken, sheetId: oldSheet, headers, dataRows: oldRows });
    if(matches){
      log?.("unchanged — skipping write");
      return { ...base, changed: false };
    }
  }

  await rebuildTab({ ssToken, sheetId: newSheet, headers, dataRows: newRows, chunk: cfg.sheetWriteChunk, dryRun, log });
  await rebuildTab({ ssToken, sheetId: oldSheet, headers, dataRows: oldRows, chunk: cfg.sheetWriteChunk, dryRun, log });

  return { ...base, changed: true };
}
