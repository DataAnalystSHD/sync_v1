// Read / delete the shared sync-history log (every Sync Now / cron run is
// appended by logHistory). Uses the owner token so any signed-in user sees the
// full team history.
//
//   GET    /api/history            → { ok, items: [{row,time,sheetUrl,larkUrl,direction,user,rowCount,status,error}] }
//   DELETE /api/history?row=<n>    → blank one history row
//   DELETE /api/history?all=1      → clear all history rows
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig } from "./_lib/config.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { sheetsGetValues, sheetsClear } from "./_lib/google/sheets.js";

const MAX_ITEMS = 500;

function queryParam(req, name){
  if(req.query?.[name] !== undefined) return req.query[name];
  if(req.url){
    try { return new URL(req.url, "http://x").searchParams.get(name); } catch {}
  }
  return req.body?.[name];
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
    if(!ownerRefresh) return json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env" });
    if(!cfg.historySheetId) return json(res, 400, { ok: false, error: "Missing HISTORY_SHEET_ID env" });
    const access = await refreshAccessToken(ownerRefresh);

    // ── DELETE: clear one row, or all ──
    if(req.method === "DELETE"){
      const all = queryParam(req, "all");
      const row = parseInt(queryParam(req, "row"), 10);
      if(all){
        await sheetsClear({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A1:H50000` });
        return json(res, 200, { ok: true, cleared: "all" });
      }
      if(Number.isFinite(row) && row >= 1){
        await sheetsClear({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A${row}:H${row}` });
        return json(res, 200, { ok: true, cleared: row });
      }
      return json(res, 400, { ok: false, error: "need ?row=<n> or ?all=1" });
    }

    if(req.method !== "GET") return methodNotAllowed(res);

    // ── GET: newest-first list ──
    const rows = await sheetsGetValues({
      accessToken: access,
      spreadsheetId: cfg.historySheetId,
      range: `${cfg.historyTab}!A1:H50000`,
    });

    // logHistory writes: [timestamp, sheetUrl, larkUrl, direction, user, rowCount, status, error]
    // `row` = actual sheet row (1-based) so the client can delete a specific entry.
    const items = (rows || [])
      .map((r, i) => ({ r, row: i + 1 }))
      .filter(({ r }) => r && r[0] && /\d{4}-\d{2}-\d{2}T/.test(String(r[0])))
      .map(({ r, row }) => ({
        row,
        time:     r[0] || "",
        sheetUrl: r[1] || "",
        larkUrl:  r[2] || "",
        direction:r[3] || "",
        user:     r[4] || "",
        rowCount: r[5] || 0,
        status:   r[6] || "",
        error:    r[7] || "",
      }))
      .reverse()
      .slice(0, MAX_ITEMS);

    json(res, 200, { ok: true, items });
  }catch(e){
    errorResponse(res, e);
  }
}
