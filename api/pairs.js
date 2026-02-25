import {
  json, mustEnv, getConfig,
  parseGoogleSheetId, parseLarkBase,
  encryptText, decryptText,
  refreshAccessToken,
  sheetsGetValues, sheetsAppend, sheetsUpdate
} from "./_util.js";

function colToA1(colIdx){ // 0->A
  let n = colIdx + 1;
  let s = "";
  while(n>0){
    const r = (n-1)%26;
    s = String.fromCharCode(65+r) + s;
    n = Math.floor((n-1)/26);
  }
  return s;
}

async function readPairsTab({ accessToken, spreadsheetId, pairsTab }){
  const rows = await sheetsGetValues({ accessToken, spreadsheetId, range: `${pairsTab}!A1:L20000` });
  if(rows.length <= 1) return [];
  const header = rows[0];
  const data = rows.slice(1);
  // return with row index in sheet for updates
  return data.map((r, i) => ({
    rowId: i + 2,
    createdAt: r[0] || "",
    sheetUrl: r[1] || "",
    sheetId: r[2] || "",
    larkUrl: r[3] || "",
    baseId: r[4] || "",
    tableId: r[5] || "",
    direction: r[6] || "",
    user: r[7] || "",
    refreshEnc: r[8] || "",
    active: (String(r[9]||"TRUE").toUpperCase() !== "FALSE"),
    lastSyncAt: r[10] || "",
    notes: r[11] || ""
  })).filter(x => x.sheetId && x.baseId && x.tableId);
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const secret = mustEnv("SYNC_SECRET");

    if(req.method === "POST"){
      const body = req.body || {};
      const refreshToken = body.refreshToken || body.refresh_token || "";
      if(!refreshToken) throw new Error("Missing refreshToken");
      const accessToken = await refreshAccessToken(refreshToken);

      // POST without sheetUrl/larkUrl => list
      if(!body.sheetUrl || !body.larkUrl){
        const pairs = await readPairsTab({ accessToken, spreadsheetId: cfg.historySheetId, pairsTab: cfg.pairsTab });
        const activePairs = pairs.filter(p => p.active);
        json(res, 200, { ok:true, pairs: activePairs });
        return;
      }

      const sheetUrl = String(body.sheetUrl);
      const larkUrl = String(body.larkUrl);
      const direction = body.direction === "sheet-to-lark" ? "sheet-to-lark" : "lark-to-sheet";
      const userEmail = body.userEmail || body.user || "";

      const sheetId = parseGoogleSheetId(sheetUrl);
      if(!sheetId) throw new Error("Invalid Google Sheet URL");
      const { baseId, tableId } = parseLarkBase(larkUrl);
      if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");

      const refreshEnc = encryptText(refreshToken, secret);
      const row = [
        new Date().toISOString(),
        sheetUrl,
        sheetId,
        larkUrl,
        baseId,
        tableId,
        direction,
        userEmail,
        refreshEnc,
        "TRUE",
        "",
        ""
      ];

      await sheetsAppend({ accessToken, spreadsheetId: cfg.historySheetId, range: `${cfg.pairsTab}!A:L`, values: row });
      json(res, 200, { ok:true, saved:true, sheetId, baseId, tableId });
      return;
    }

    if(req.method === "PUT"){
      const body = req.body || {};
      const refreshToken = body.refreshToken || "";
      const rowId = parseInt(body.rowId, 10);
      if(!refreshToken) throw new Error("Missing refreshToken");
      if(!rowId) throw new Error("Missing rowId");
      const accessToken = await refreshAccessToken(refreshToken);

      const active = body.active === false ? "FALSE" : "TRUE";
      // column J is Active (index 9 => J)
      const range = `${cfg.pairsTab}!J${rowId}:J${rowId}`;
      await sheetsUpdate({ accessToken, spreadsheetId: cfg.historySheetId, range, values: [[active]] });
      json(res, 200, { ok:true, updated:true });
      return;
    }

    json(res, 405, { ok:false, error:"Method not allowed" });
  }catch(e){
    json(res, 500, { ok:false, error:e.message });
  }
}