// Scan the source side of a would-be pair and return its column/field names,
// so the web UI can show a "pick columns to sync" checklist.
//
//   POST { refreshToken, direction, sheetUrl, larkUrl } → { ok, headers: [...] }
//
// Uses the caller's own Google token (same as /api/pairs) so it only sees
// sheets they can access. Lark sources use the app's tenant token internally.
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { listSourceColumns, listSourceFilterFields } from "./_services/list-columns.js";

export default async function handler(req, res){
  try{
    if(req.method !== "POST") return methodNotAllowed(res);
    const body = req.body || {};
    const refreshToken = body.refreshToken || body.refresh_token || "";
    if(!refreshToken) throw new Error("Missing refreshToken");
    const direction = String(body.direction || "");
    if(!direction) throw new Error("Missing direction");

    const accessToken = await refreshAccessToken(refreshToken);
    const headers = await listSourceColumns({
      accessToken,
      direction,
      sheetUrl: body.sheetUrl || "",
      larkUrl:  body.larkUrl  || "",
    });
    // Dropdown/select fields for the value-filter UI (Lark Base sources only).
    let filterFields = [];
    try {
      filterFields = await listSourceFilterFields({ direction, sheetUrl: body.sheetUrl || "", larkUrl: body.larkUrl || "" });
    } catch { filterFields = []; }
    json(res, 200, { ok: true, headers, filterFields });
  }catch(e){
    errorResponse(res, e);
  }
}
