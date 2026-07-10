import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig, mustEnv } from "./_lib/config.js";
import { encryptText } from "./_lib/crypto.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { parseGoogleSheetId, parseLarkBase, parseLarkSheetUrl } from "./_lib/urls.js";
import {
  readAllPairs, appendPair, setActive, setPairInterval, setSyncMode, deletePairRow, updatePairFields,
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

function toPos(v){
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// Any positive interval is allowed now (custom minutes), clamped to a sane
// range: 1 minute .. 7 days. Invalid → 60.
function normInterval(v){
  const n = toPos(v);
  if(!n) return 60;
  return Math.min(Math.max(n, 1), 10080);
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
    columns:     Array.isArray(p.columns) ? p.columns : [],
    filters:     Array.isArray(p.filters) ? p.filters : [],
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

  const intervalMin = normInterval(body.intervalMin);

  // Selected columns (empty/absent = all). Stored as header names.
  const columns = Array.isArray(body.columns) ? body.columns.map(String) : [];
  // Value filters (empty/absent = all rows).
  const filters = Array.isArray(body.filters) ? body.filters : [];

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
      columns,
      filters,
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

  // Full edit from the Sync form (both URLs present) → rewrite the whole config.
  if(body.sheetUrl && body.larkUrl){
    const sheetUrl  = String(body.sheetUrl);
    const larkUrl   = String(body.larkUrl);
    const direction = FIELD_KINDS[body.direction] ? body.direction : "lark-to-sheet";
    const kinds = FIELD_KINDS[direction];
    validateSide(kinds.top,    sheetUrl, "source");
    validateSide(kinds.bottom, larkUrl,  "destination");
    const { sheetId, baseId, tableId } = extractIds({ direction, sheetUrl, larkUrl });
    const intervalMin = normInterval(body.intervalMin);
    await updatePairFields({
      accessToken, cfg, rowId,
      fields: {
        sheetUrl, sheetId, larkUrl, baseId, tableId, direction,
        syncMode: body.syncMode, intervalMin,
        columns: Array.isArray(body.columns) ? body.columns.map(String) : [],
        filters: Array.isArray(body.filters) ? body.filters : [],
      },
    });
    return json(res, 200, { ok: true, updated: true });
  }

  if(body.intervalMin != null){
    await setPairInterval({ accessToken, cfg, rowId, intervalMin: normInterval(body.intervalMin) });
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
