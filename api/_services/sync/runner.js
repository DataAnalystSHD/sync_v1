import { parseGoogleSheetUrl, parseLarkBase, parseLarkSheetUrl } from "../../_lib/urls.js";
import { syncLarkToSheet } from "./lark-to-sheet.js";
import { syncSheetToLark } from "./sheet-to-lark.js";
import { syncLarkSheetToLarkBase } from "./larksheet-to-larkbase.js";
import { syncLarkBaseToLarkSheet } from "./larkbase-to-larksheet.js";
import { syncLarkSheetToGoogleSheet } from "./larksheet-to-googlesheet.js";
import { syncGoogleSheetToLarkSheet } from "./googlesheet-to-larksheet.js";

const DIRECTIONS = new Set([
  "lark-to-sheet",
  "sheet-to-lark",
  "larksheet-to-larkbase",
  "larkbase-to-larksheet",
  "larksheet-to-googlesheet",
  "googlesheet-to-larksheet",
]);

function resolveBase(pair){
  const parsed = parseLarkBase(pair.larkUrl);
  const baseId  = pair.baseId  || parsed.baseId;
  const tableId = pair.tableId || parsed.tableId;
  const viewId  = parsed.viewId || "";
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");
  return { baseId, tableId, viewId };
}

function resolveGoogleSheet(pair){
  const parsed = parseGoogleSheetUrl(pair.sheetUrl);
  const sheetId = pair.sheetId || parsed.id;
  if(!sheetId) throw new Error("Invalid Google Sheet URL");
  return { sheetId, gid: parsed.gid };
}

function ensureLarkSheetUrl(url){
  if(!parseLarkSheetUrl(url).token){
    throw new Error("Invalid Lark Sheet URL (need /wiki/... or /sheets/...)");
  }
}

// Sanitize the row-range hints coming from the form. Stored as 1-based data
// row indices (header excluded for sheets, record index for Lark Base).
// Anything falsey / non-positive becomes null = "no limit".
function normRowRange(pair){
  const toPos = v => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  return { rowFrom: toPos(pair?.rowFrom), rowTo: toPos(pair?.rowTo) };
}

function normSyncMode(pair){
  return pair?.syncMode === "append" ? "append" : "replace";
}

export async function runOne({ accessToken, cfg, pair }){
  const direction = DIRECTIONS.has(pair.direction) ? pair.direction : "lark-to-sheet";
  const { rowFrom, rowTo } = normRowRange(pair);
  const syncMode = normSyncMode(pair);
  // Chosen columns (empty = all). The runner just forwards them; each service
  // decides how to apply the filter for its header model.
  const columns = Array.isArray(pair.columns) ? pair.columns : [];
  // Value filters (empty = all rows). Only Lark Base source directions apply them.
  const filters = Array.isArray(pair.filters) ? pair.filters : [];

  if(direction === "lark-to-sheet"){
    const { sheetId, gid } = resolveGoogleSheet(pair);
    const { baseId, tableId, viewId } = resolveBase(pair);
    return await syncLarkToSheet({ accessToken, cfg, sheetId, gid, baseId, tableId, viewId, rowFrom, rowTo, syncMode, columns, filters });
  }

  if(direction === "sheet-to-lark"){
    const { sheetId, gid } = resolveGoogleSheet(pair);
    const { baseId, tableId } = resolveBase(pair);
    return await syncSheetToLark({ accessToken, cfg, sheetId, gid, baseId, tableId, pair, rowFrom, rowTo, syncMode, columns });
  }

  if(direction === "larksheet-to-larkbase"){
    ensureLarkSheetUrl(pair.sheetUrl);
    const { baseId, tableId } = resolveBase(pair);
    return await syncLarkSheetToLarkBase({
      accessToken, cfg, sourceUrl: pair.sheetUrl, baseId, tableId, pair, rowFrom, rowTo, syncMode, columns,
    });
  }

  if(direction === "larkbase-to-larksheet"){
    ensureLarkSheetUrl(pair.sheetUrl);
    const { baseId, tableId, viewId } = resolveBase(pair);
    return await syncLarkBaseToLarkSheet({
      cfg, baseId, tableId, viewId, destUrl: pair.sheetUrl, rowFrom, rowTo, syncMode, columns, filters,
    });
  }

  // For Sheet ↔ Lark Sheet directions there is no Lark Base in the picture,
  // so the form's two fields hold (source URL, dest URL) directly:
  //   pair.sheetUrl = top input    (the source side)
  //   pair.larkUrl  = bottom input (the destination side)
  if(direction === "larksheet-to-googlesheet"){
    ensureLarkSheetUrl(pair.sheetUrl);
    const { id: gSheetId, gid } = parseGoogleSheetUrl(pair.larkUrl);
    if(!gSheetId) throw new Error("Invalid Google Sheet URL (destination)");
    return await syncLarkSheetToGoogleSheet({
      accessToken, cfg,
      sourceUrl: pair.sheetUrl,
      destSheetId: gSheetId, destGid: gid,
      rowFrom, rowTo, syncMode, columns,
    });
  }

  if(direction === "googlesheet-to-larksheet"){
    const { id: gSheetId, gid } = parseGoogleSheetUrl(pair.sheetUrl);
    if(!gSheetId) throw new Error("Invalid Google Sheet URL (source)");
    ensureLarkSheetUrl(pair.larkUrl);
    return await syncGoogleSheetToLarkSheet({
      accessToken, cfg,
      srcSheetId: gSheetId, srcGid: gid,
      destUrl: pair.larkUrl,
      rowFrom, rowTo, syncMode, columns,
    });
  }

  throw new Error(`Unknown direction: ${direction}`);
}
