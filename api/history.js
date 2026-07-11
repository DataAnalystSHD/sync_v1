// Read / delete the sync-history log (every Sync Now / cron run is appended by
// logHistory). The sheet is read with the OWNER token so any signed-in user
// works; each user is then scoped to their own rows by their verified email.
// The admin email(s) see and can delete everyone's.
//
//   POST   /api/history            { refreshToken }        → { ok, items: [...] }
//   DELETE /api/history            { refreshToken, row }   → blank one owned row
//   DELETE /api/history            { refreshToken, all:1 } → clear own rows (all, if admin)
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig } from "./_lib/config.js";
import { refreshAccessToken, emailFromAccessToken } from "./_lib/google/oauth.js";
import { sheetsGetValues, sheetsClear } from "./_lib/google/sheets.js";

const MAX_ITEMS = 500;
const USER_COL = 4;   // logHistory column E = user email

function bodyParam(req, name){
  if(req.body?.[name] !== undefined) return req.body[name];
  if(req.query?.[name] !== undefined) return req.query[name];
  return undefined;
}

// logHistory writes: [timestamp, sheetUrl, larkUrl, direction, user, rowCount, status, error]
function rowToItem(r, row){
  return {
    row,
    time:     r[0] || "",
    sheetUrl: r[1] || "",
    larkUrl:  r[2] || "",
    direction:r[3] || "",
    user:     r[4] || "",
    rowCount: r[5] || 0,
    status:   r[6] || "",
    error:    r[7] || "",
  };
}

const isHistoryRow = (r) => r && r[0] && /\d{4}-\d{2}-\d{2}T/.test(String(r[0]));
const owns = (r, email) => String(r[USER_COL] || "").trim().toLowerCase() === email;

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
    if(!ownerRefresh) return json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env" });
    if(!cfg.historySheetId) return json(res, 400, { ok: false, error: "Missing HISTORY_SHEET_ID env" });

    // Caller identity (their own token) — required to scope to their own history.
    const callerRefresh = bodyParam(req, "refreshToken") || bodyParam(req, "refresh_token");
    if(!callerRefresh) return json(res, 401, { ok: false, error: "Missing refreshToken" });
    const callerEmail = await emailFromAccessToken(await refreshAccessToken(callerRefresh));
    const isAdmin = cfg.adminEmails.includes(callerEmail);

    const access = await refreshAccessToken(ownerRefresh);   // owner token reads/clears the sheet

    // ── DELETE: clear one row, or all (own rows only, unless admin) ──
    if(req.method === "DELETE"){
      const all = bodyParam(req, "all");
      const row = parseInt(bodyParam(req, "row"), 10);

      if(Number.isFinite(row) && row >= 1){
        const rows = await sheetsGetValues({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A${row}:H${row}` });
        const r = rows?.[0];
        if(r && isHistoryRow(r) && !isAdmin && !owns(r, callerEmail)){
          return json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ลบรายการนี้" });
        }
        await sheetsClear({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A${row}:H${row}` });
        return json(res, 200, { ok: true, cleared: row });
      }

      if(all){
        if(isAdmin){
          await sheetsClear({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A1:H50000` });
          return json(res, 200, { ok: true, cleared: "all" });
        }
        // Non-admin: blank only their own rows.
        const rows = await sheetsGetValues({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A1:H50000` });
        const mine = (rows || []).map((r, i) => ({ r, row: i + 1 })).filter(({ r }) => isHistoryRow(r) && owns(r, callerEmail));
        for(const { row } of mine){
          await sheetsClear({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A${row}:H${row}` });
        }
        return json(res, 200, { ok: true, cleared: mine.length });
      }
      return json(res, 400, { ok: false, error: "need row or all" });
    }

    if(req.method !== "POST") return methodNotAllowed(res);

    // ── POST: newest-first list, scoped to the caller (admin sees all) ──
    const rows = await sheetsGetValues({ accessToken: access, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A1:H50000` });
    const items = (rows || [])
      .map((r, i) => ({ r, row: i + 1 }))
      .filter(({ r }) => isHistoryRow(r) && (isAdmin || owns(r, callerEmail)))
      .map(({ r, row }) => rowToItem(r, row))
      .reverse()
      .slice(0, MAX_ITEMS);

    json(res, 200, { ok: true, items });
  }catch(e){
    errorResponse(res, e);
  }
}
