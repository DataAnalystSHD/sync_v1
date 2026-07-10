// Read the shared sync-history log (every Sync Now / cron run is appended here
// by logHistory). Returns newest-first. Uses the owner token so any signed-in
// user sees the full team history.
//
//   GET /api/history            → { ok, items: [{time,sheetUrl,larkUrl,direction,user,rowCount,status,error}] }
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig } from "./_lib/config.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { sheetsGetValues } from "./_lib/google/sheets.js";

const MAX_ITEMS = 500;

export default async function handler(req, res){
  try{
    if(req.method !== "GET") return methodNotAllowed(res);
    const cfg = getConfig();
    const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
    if(!ownerRefresh) return json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env" });
    if(!cfg.historySheetId) return json(res, 400, { ok: false, error: "Missing HISTORY_SHEET_ID env" });

    const access = await refreshAccessToken(ownerRefresh);
    const rows = await sheetsGetValues({
      accessToken: access,
      spreadsheetId: cfg.historySheetId,
      range: `${cfg.historyTab}!A1:H50000`,
    });

    // logHistory writes: [timestamp, sheetUrl, larkUrl, direction, user, rowCount, status, error]
    // Skip a header row if present (col A not an ISO date).
    const items = (rows || [])
      .filter(r => r && r[0] && /\d{4}-\d{2}-\d{2}T/.test(String(r[0])))
      .map(r => ({
        time:     r[0] || "",
        sheetUrl: r[1] || "",
        larkUrl:  r[2] || "",
        direction:r[3] || "",
        user:     r[4] || "",
        rowCount: r[5] || 0,
        status:   r[6] || "",
        error:    r[7] || "",
      }))
      .reverse()               // newest first
      .slice(0, MAX_ITEMS);

    json(res, 200, { ok: true, items });
  }catch(e){
    errorResponse(res, e);
  }
}
