import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig, mustEnv } from "./_lib/config.js";
import { encryptText } from "./_lib/crypto.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { parseGoogleSheetId, parseLarkBase } from "./_lib/urls.js";
import { readActivePairs, appendPair, setActive } from "./_services/pairs-store.js";

async function handlePost({ req, res, cfg, secret }){
  const body = req.body || {};
  const refreshToken = body.refreshToken || body.refresh_token || "";
  if(!refreshToken) throw new Error("Missing refreshToken");
  const accessToken = await refreshAccessToken(refreshToken);

  if(!body.sheetUrl || !body.larkUrl){
    const pairs = await readActivePairs({ accessToken, cfg });
    json(res, 200, { ok: true, pairs });
    return;
  }

  const sheetUrl  = String(body.sheetUrl);
  const larkUrl   = String(body.larkUrl);
  const direction = body.direction === "sheet-to-lark" ? "sheet-to-lark" : "lark-to-sheet";
  const userEmail = body.userEmail || body.user || "";

  const sheetId = parseGoogleSheetId(sheetUrl);
  if(!sheetId) throw new Error("Invalid Google Sheet URL");
  const { baseId, tableId } = parseLarkBase(larkUrl);
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");

  await appendPair({
    accessToken,
    cfg,
    pair: {
      sheetUrl, sheetId,
      larkUrl, baseId, tableId,
      direction, userEmail,
      refreshEnc: encryptText(refreshToken, secret),
    },
  });

  json(res, 200, { ok: true, saved: true, sheetId, baseId, tableId });
}

async function handlePut({ req, res, cfg }){
  const body = req.body || {};
  const refreshToken = body.refreshToken || "";
  const rowId = parseInt(body.rowId, 10);
  if(!refreshToken) throw new Error("Missing refreshToken");
  if(!rowId) throw new Error("Missing rowId");

  const accessToken = await refreshAccessToken(refreshToken);
  await setActive({ accessToken, cfg, rowId, active: body.active !== false });
  json(res, 200, { ok: true, updated: true });
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const secret = mustEnv("SYNC_SECRET");

    if(req.method === "POST") return await handlePost({ req, res, cfg, secret });
    if(req.method === "PUT")  return await handlePut({ req, res, cfg });
    methodNotAllowed(res);
  }catch(e){
    errorResponse(res, e);
  }
}
