import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig, mustEnv } from "./_lib/config.js";
import { encryptText } from "./_lib/crypto.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { parseGoogleSheetId, parseLarkBase, parseLarkSheetUrl } from "./_lib/urls.js";
import {
  readAllPairs, appendPair, setActive, setPairInterval, setSyncMode, deletePairRow,
} from "./_services/pairs-store.js";

// What each side of the form holds, per direction.
//   top    = sheetUrl input
//   bottom = larkUrl input
const FIELD_KINDS = {
  "lark-to-sheet":            { top: "google",    bottom: "larkBase"  },
  "sheet-to-lark":            { top: "google",    bottom: "larkBase"  },
  "larksheet-to-larkbase":    { top: "larkSheet", bottom: "larkBase"  },
  "larkbase-to-larksheet":    { top: "larkSheet", bottom: "larkBase"  },
  "larksheet-to-googlesheet": { top: "larkSheet", bottom: "google"    },
  "googlesheet-to-larksheet": { top: "google",    bottom: "larkSheet" },
};

const ALLOWED_INTERVALS = new Set([5, 15, 30, 60, 120, 360, 720, 1440]);

function toPos(v){
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function validateSide(kind, url, label){
  if(kind === "google"){
    if(!parseGoogleSheetId(url)) throw new Error(`Invalid Google Sheet URL (${label})`);
  } else if(kind === "larkSheet"){
    if(!parseLarkSheetUrl(url).token) throw new Error(`Invalid Lark Sheet URL (${label}) — need /wiki/... or /sheets/...`);
  } else if(kind === "larkBase"){
    const { baseId, tableId } = parseLarkBase(url);
    if(!baseId || !tableId) throw new Error(`Invalid Lark Base URL (${label}) — need /base/<baseId>?table=<tableId>`);
  }
}

// Best-effort legacy id columns. The sync runner re-parses every URL itself,
// so these are only stored for reference / back-compat.
function extractIds({ direction, sheetUrl, larkUrl }){
  const kinds = FIELD_KINDS[direction];
  const out = { sheetId: "", baseId: "", tableId: "" };
  const googleUrl = kinds.top === "google" ? sheetUrl : (kinds.bottom === "google" ? larkUrl : "");
  if(googleUrl) out.sheetId = parseGoogleSheetId(googleUrl);
  const baseUrl = kinds.top === "larkBase" ? sheetUrl : (kinds.bottom === "larkBase" ? larkUrl : "");
  if(baseUrl){
    const { baseId, tableId } = parseLarkBase(baseUrl);
    out.baseId = baseId; out.tableId = tableId;
  }
  return out;
}

// Strip the encrypted token before sending pairs to the browser.
function publicPair(p){
  return {
    rowId:       p.rowId,
    createdAt:   p.createdAt,
    sheetUrl:    p.sheetUrl,
    larkUrl:     p.larkUrl,
    direction:   p.direction,
    user:        p.user,
    active:      p.active,
    lastSyncAt:  p.lastSyncAt,
    intervalMin: p.intervalMin,
    rowFrom:     p.rowFrom,
    rowTo:       p.rowTo,
    syncMode:    p.syncMode,
  };
}

async function handlePost({ req, res, cfg, secret }){
  const body = req.body || {};
  const refreshToken = body.refreshToken || body.refresh_token || "";
  if(!refreshToken) throw new Error("Missing refreshToken");
  const accessToken = await refreshAccessToken(refreshToken);

  // No URLs → list every saved pair (for the Cron Manager).
  if(!body.sheetUrl || !body.larkUrl){
    const pairs = (await readAllPairs({ accessToken, cfg })).map(publicPair);
    json(res, 200, { ok: true, pairs });
    return;
  }

  const sheetUrl  = String(body.sheetUrl);
  const larkUrl   = String(body.larkUrl);
  const direction = FIELD_KINDS[body.direction] ? body.direction : "lark-to-sheet";
  const userEmail = body.userEmail || body.user || "";

  const kinds = FIELD_KINDS[direction];
  validateSide(kinds.top,    sheetUrl, "source");
  validateSide(kinds.bottom, larkUrl,  "destination");

  const { sheetId, baseId, tableId } = extractIds({ direction, sheetUrl, larkUrl });

  let intervalMin = toPos(body.intervalMin) || 60;
  if(!ALLOWED_INTERVALS.has(intervalMin)) intervalMin = 60;

  await appendPair({
    accessToken,
    cfg,
    pair: {
      sheetUrl, sheetId,
      larkUrl, baseId, tableId,
      direction, userEmail,
      refreshEnc: encryptText(refreshToken, secret),
      intervalMin,
      rowFrom:  toPos(body.rowFrom),
      rowTo:    toPos(body.rowTo),
      syncMode: body.syncMode === "append" ? "append" : "replace",
    },
  });

  json(res, 200, { ok: true, saved: true, direction, intervalMin });
}

async function handlePut({ req, res, cfg }){
  const body = req.body || {};
  const refreshToken = body.refreshToken || "";
  const rowId = parseInt(body.rowId, 10);
  if(!refreshToken) throw new Error("Missing refreshToken");
  if(!rowId) throw new Error("Missing rowId");

  const accessToken = await refreshAccessToken(refreshToken);

  if(body.intervalMin != null){
    let intervalMin = toPos(body.intervalMin) || 60;
    if(!ALLOWED_INTERVALS.has(intervalMin)) intervalMin = 60;
    await setPairInterval({ accessToken, cfg, rowId, intervalMin });
  }
  if(body.active != null){
    await setActive({ accessToken, cfg, rowId, active: body.active !== false });
  }
  if(body.syncMode != null){
    await setSyncMode({ accessToken, cfg, rowId, syncMode: body.syncMode === "append" ? "append" : "replace" });
  }
  json(res, 200, { ok: true, updated: true });
}

async function handleDelete({ req, res, cfg }){
  const body = req.body || {};
  const refreshToken = body.refreshToken || "";
  const rowId = parseInt(body.rowId, 10);
  if(!refreshToken) throw new Error("Missing refreshToken");
  if(!rowId) throw new Error("Missing rowId");

  const accessToken = await refreshAccessToken(refreshToken);
  await deletePairRow({ accessToken, cfg, rowId });
  json(res, 200, { ok: true, deleted: true });
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const secret = mustEnv("SYNC_SECRET");

    if(req.method === "POST")   return await handlePost({ req, res, cfg, secret });
    if(req.method === "PUT")    return await handlePut({ req, res, cfg });
    if(req.method === "DELETE") return await handleDelete({ req, res, cfg });
    methodNotAllowed(res);
  }catch(e){
    errorResponse(res, e);
  }
}
