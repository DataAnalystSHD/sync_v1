import { parseGoogleSheetId, parseLarkBase } from "../../_lib/urls.js";
import { syncLarkToSheet } from "./lark-to-sheet.js";
import { syncSheetToLark } from "./sheet-to-lark.js";

function resolveTargets(pair){
  const sheetId = pair.sheetId || parseGoogleSheetId(pair.sheetUrl);
  if(!sheetId) throw new Error("Invalid Google Sheet URL");

  const parsed = parseLarkBase(pair.larkUrl);
  const baseId  = pair.baseId  || parsed.baseId;
  const tableId = pair.tableId || parsed.tableId;
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");

  return { sheetId, baseId, tableId };
}

export async function runOne({ accessToken, cfg, pair }){
  const { sheetId, baseId, tableId } = resolveTargets(pair);
  const direction = pair.direction === "sheet-to-lark" ? "sheet-to-lark" : "lark-to-sheet";

  if(direction === "lark-to-sheet"){
    return await syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId });
  }
  return await syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId, pair });
}
