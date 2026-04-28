import { parseGoogleSheetId, parseLarkBase, parseLarkSheetUrl } from "../../_lib/urls.js";
import { syncLarkToSheet } from "./lark-to-sheet.js";
import { syncSheetToLark } from "./sheet-to-lark.js";
import { syncLarkSheetToLarkBase } from "./larksheet-to-larkbase.js";
import { syncLarkBaseToLarkSheet } from "./larkbase-to-larksheet.js";

const DIRECTIONS = new Set([
  "lark-to-sheet",
  "sheet-to-lark",
  "larksheet-to-larkbase",
  "larkbase-to-larksheet",
]);

function resolveBase(pair){
  const parsed = parseLarkBase(pair.larkUrl);
  const baseId  = pair.baseId  || parsed.baseId;
  const tableId = pair.tableId || parsed.tableId;
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");
  return { baseId, tableId };
}

function resolveGoogleSheetId(pair){
  const sheetId = pair.sheetId || parseGoogleSheetId(pair.sheetUrl);
  if(!sheetId) throw new Error("Invalid Google Sheet URL");
  return sheetId;
}

function ensureLarkSheetUrl(url){
  if(!parseLarkSheetUrl(url).token){
    throw new Error("Invalid Lark Sheet URL (need /wiki/... or /sheets/...)");
  }
}

export async function runOne({ accessToken, cfg, pair }){
  const direction = DIRECTIONS.has(pair.direction) ? pair.direction : "lark-to-sheet";

  if(direction === "lark-to-sheet"){
    const sheetId = resolveGoogleSheetId(pair);
    const { baseId, tableId } = resolveBase(pair);
    return await syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId });
  }

  if(direction === "sheet-to-lark"){
    const sheetId = resolveGoogleSheetId(pair);
    const { baseId, tableId } = resolveBase(pair);
    return await syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId, pair });
  }

  if(direction === "larksheet-to-larkbase"){
    ensureLarkSheetUrl(pair.sheetUrl);
    const { baseId, tableId } = resolveBase(pair);
    return await syncLarkSheetToLarkBase({
      accessToken, cfg, sourceUrl: pair.sheetUrl, baseId, tableId, pair,
    });
  }

  if(direction === "larkbase-to-larksheet"){
    ensureLarkSheetUrl(pair.sheetUrl);
    const { baseId, tableId } = resolveBase(pair);
    return await syncLarkBaseToLarkSheet({
      cfg, baseId, tableId, destUrl: pair.sheetUrl,
    });
  }

  throw new Error(`Unknown direction: ${direction}`);
}
