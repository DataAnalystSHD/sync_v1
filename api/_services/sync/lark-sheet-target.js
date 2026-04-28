import { parseLarkSheetUrl } from "../../_lib/urls.js";
import { resolveWikiNode } from "../../_lib/lark/wiki.js";
import { listSheets } from "../../_lib/lark/sheets.js";

/**
 * Resolve a Lark Sheet URL to the API tokens needed for read/write.
 *
 * Accepts both:
 *   - https://<host>/wiki/<wikiToken>          → resolves via wiki node
 *   - https://<host>/sheets/<spreadsheetToken> → direct
 *
 * Optional `?sheet=<sheetId>` selects a sheet; otherwise the first sheet is used.
 */
export async function resolveLarkSheetTarget(url){
  const parsed = parseLarkSheetUrl(url);
  if(!parsed.token) throw new Error("Invalid Lark Sheet URL (need /wiki/... or /sheets/...)");

  let ssToken = parsed.token;
  if(parsed.kind === "wiki"){
    const { objToken, objType } = await resolveWikiNode(parsed.token);
    if(!objToken) throw new Error("Wiki node has no underlying object");
    if(objType !== "sheet") throw new Error(`Wiki node is type=${objType}, expected sheet`);
    ssToken = objToken;
  }

  let sheetId = parsed.sheetId;
  if(!sheetId){
    const sheets = await listSheets(ssToken);
    if(sheets.length === 0) throw new Error("Lark spreadsheet has no sheets");
    sheetId = sheets[0].sheet_id;
  }

  return { ssToken, sheetId };
}
