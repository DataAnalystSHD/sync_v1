import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig, mustEnv } from "./_lib/config.js";
import { decryptText } from "./_lib/crypto.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { readActiveCronPairs, updateLastSync } from "./_services/pairs-store.js";
import { logHistory } from "./_services/history.js";
import { runOne } from "./_services/sync/runner.js";
import { notifyLarkBot, summarizeBatch } from "./_lib/lark/notify.js";

function shortLabel(url){
  if(!url) return "(no url)";
  const s = String(url);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

function resultLine(r, fallbackUrl){
  const label = shortLabel(r.pair || fallbackUrl);
  if(r.status === "success"){
    return `✅ \`${label}\` — ${r.rowCount ?? 0} rows`;
  }
  return `❌ \`${label}\` — ${r.error || "error"}`;
}

function pickResultFields(r){
  return {
    rowCount:      r.rowCount,
    truncated:     r.truncated || false,
    done:          r.done || false,
    page:          r.page || null,
    nextCursorRow: r.nextCursorRow || null,
  };
}

async function recordResult({ accessToken, cfg, pair, user, result, error }){
  await logHistory({
    accessToken,
    cfg,
    sheetUrl:  pair.sheetUrl,
    larkUrl:   pair.larkUrl,
    direction: pair.direction,
    user,
    rowCount:  result?.rowCount || 0,
    status:    error ? "Error" : "Success",
    error:     error?.message || "",
  });
}

async function handleCron({ res, cfg }){
  const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
  if(!ownerRefresh){
    json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env. Cron mode needs an owner refresh token to read pairs." });
    return;
  }

  const ownerAccess = await refreshAccessToken(ownerRefresh);
  const pairs = await readActiveCronPairs({ accessToken: ownerAccess, cfg });
  const secret = mustEnv("SYNC_SECRET");

  const results = [];
  for(const p of pairs){
    const pairRefresh = decryptText(p.refreshEnc, secret);
    const accessToken = await refreshAccessToken(pairRefresh);
    const user = p.user || "cron";
    try{
      const r = await runOne({ accessToken, cfg, pair: { ...p, refreshToken: pairRefresh, userEmail: user } });
      results.push({ pair: p.sheetUrl, status: "success", ...pickResultFields(r) });
      await updateLastSync({ accessToken, cfg, rowId: p.rowId });
      await recordResult({ accessToken, cfg, pair: p, user, result: r });
    }catch(e){
      results.push({ pair: p.sheetUrl, status: "error", error: e.message });
      await recordResult({ accessToken, cfg, pair: p, user, error: e });
    }
  }

  const { ok, fail, total } = summarizeBatch(results);
  await notifyLarkBot({
    title: fail > 0 ? `⚠️ Cron sync — ${fail}/${total} failed` : `✅ Cron sync — ${ok}/${total} ok`,
    success: fail === 0,
    lines: results.map(r => resultLine(r)),
  });

  json(res, 200, { ok: true, mode: "cron", processed: results.length, results });
}

async function handleManual({ req, res, cfg }){
  const body = req.body || {};
  const inputs = body.pairs || [];
  if(!Array.isArray(inputs) || inputs.length === 0) throw new Error("Missing pairs[]");

  const results = [];
  for(const input of inputs){
    const refreshToken = input.refreshToken || "";
    if(!refreshToken) throw new Error("Missing refreshToken in pair");
    const accessToken = await refreshAccessToken(refreshToken);
    const user = input.userEmail || input.user || "manual";

    try{
      const r = await runOne({
        accessToken, cfg,
        pair: { ...input, forceNew: input.forceNew !== false },
      });
      results.push({ status: "success", ...pickResultFields(r) });
      await recordResult({ accessToken, cfg, pair: input, user, result: r });
      if(input.rowId) await updateLastSync({ accessToken, cfg, rowId: parseInt(input.rowId, 10) });
    }catch(e){
      results.push({ status: "error", error: e.message });
      await recordResult({ accessToken, cfg, pair: input, user, error: e });
    }
  }

  const { ok, fail, total } = summarizeBatch(results);
  await notifyLarkBot({
    title: fail > 0 ? `⚠️ Manual sync — ${fail}/${total} failed` : `✅ Manual sync — ${ok}/${total} ok`,
    success: fail === 0,
    lines: results.map((r, idx) => resultLine(r, inputs[idx]?.sheetUrl)),
  });

  json(res, 200, { ok: true, processed: results.length, results });
}

export default async function handler(req, res){
  const cfg = getConfig();
  try{
    if(req.method === "GET")  return await handleCron({ res, cfg });
    if(req.method === "POST") return await handleManual({ req, res, cfg });
    methodNotAllowed(res);
  }catch(e){
    errorResponse(res, e);
  }
}
