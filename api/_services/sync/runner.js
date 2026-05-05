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

export async function runOne({ accessToken, cfg, pair }){
  const direction = DIRECTIONS.has(pair.direction) ? pair.direction : "lark-to-sheet";

  if(direction === "lark-to-sheet"){
    const { sheetId, gid } = resolveGoogleSheet(pair);
    const { baseId, tableId, viewId } = resolveBase(pair);
    return await syncLarkToSheet({ accessToken, cfg, sheetId, gid, baseId, tableId, viewId });
  }

  if(direction === "sheet-to-lark"){
    const { sheetId, gid } = resolveGoogleSheet(pair);
    const { baseId, tableId } = resolveBase(pair);
    return await syncSheetToLark({ accessToken, cfg, sheetId, gid, baseId, tableId, pair });
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
    const { baseId, tableId, viewId } = resolveBase(pair);
    return await syncLarkBaseToLarkSheet({
      cfg, baseId, tableId, viewId, destUrl: pair.sheetUrl,
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
    });
  }

  throw new Error(`Unknown direction: ${direction}`);
}
