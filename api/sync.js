import axios from "axios";
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { getConfig, mustEnv } from "./_lib/config.js";
import { decryptText } from "./_lib/crypto.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { readAllPairs, readActiveCronPairs, findPairByRowId, updateLastSync } from "./_services/pairs-store.js";
import { sheetsGetValues, sheetsClear } from "./_lib/google/sheets.js";
import { logHistory } from "./_services/history.js";
import { runOne } from "./_services/sync/runner.js";
import { runKolSplit } from "./_services/sync/kol-split.js";
import { notifyLarkBot, summarizeBatch } from "./_lib/lark/notify.js";

// Runs on every cron tick alongside the pairs sync. runKolSplit is a no-op
// write when the KOL Base is unchanged (signature guard), so a 5-min poll is
// cheap. Isolated so a failure here never breaks pairs processing. Disable by
// setting KOL_SPLIT_ENABLED=false.
async function runKolSplitStep(){
  if(String(process.env.KOL_SPLIT_ENABLED || "true").toLowerCase() === "false") return null;
  try{
    const r = await runKolSplit({ log: (m) => console.log("[kol-split]", m) });
    if(r.changed){
      await notifyLarkBot({
        title: `✅ KOL split — New ${r.newCount} / Old ${r.oldCount}`,
        success: true,
        lines: [
          `New KOL: **${r.newCount}** rows`,
          `Old KOL: **${r.oldCount}** rows`,
          `Skipped (no Promote Method): ${r.skipped}`,
        ],
      });
    }
    return { ...r, status: "success" };
  }catch(e){
    console.warn("[kol-split] failed:", e?.message || e);
    await notifyLarkBot({ title: "❌ KOL split failed", success: false, lines: [e?.message || String(e)] });
    return { status: "error", error: e?.message || String(e) };
  }
}

// When CRON_SECRET is set, the scheduled GET must present it (Vercel Cron sends
// it as `Authorization: Bearer <secret>`; external crons can use `?key=<secret>`).
// Left open only if no secret is configured, so existing setups keep working.
function cronAuthorized(req){
  const secret = process.env.CRON_SECRET;
  if(!secret) return true;
  const auth = req.headers?.authorization || "";
  if(auth === `Bearer ${secret}`) return true;
  let key = req.query?.key;
  if(!key && req.url){
    try { key = new URL(req.url, "http://x").searchParams.get("key"); } catch {}
  }
  return key === secret;
}

// A pair is due when it has never run, or its interval has elapsed. 30s of
// slack absorbs cron jitter so a "5 min" pair isn't skipped at 4m59s.
function isDue(pair, now){
  if(!pair.lastSyncAt) return true;
  const last = Date.parse(pair.lastSyncAt);
  if(!Number.isFinite(last)) return true;
  const intervalMs = (pair.intervalMin || 60) * 60000;
  return (now - last) >= (intervalMs - 30000);
}

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
  // Write history with the OWNER token so any user's sync can log a row
  // regardless of their own access to the history sheet (falls back to the
  // caller token if no owner token is configured).
  let historyAccess = accessToken;
  const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
  if(ownerRefresh){
    try { historyAccess = await refreshAccessToken(ownerRefresh); } catch {}
  }
  await logHistory({
    accessToken: historyAccess,
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

// GET /api/sync?debug=pairs — admin diagnostic (CRON_SECRET required). Shows
// what the server reads from the Pairs tab WITHOUT running any sync. Never
// returns tokens (only columns A–D of the first rows).
async function handleDebug({ res, cfg }){
  const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
  if(!ownerRefresh){
    json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env" });
    return;
  }
  const ownerAccess = await refreshAccessToken(ownerRefresh);

  // List every tab in the spreadsheet so a renamed/duplicated Pairs tab shows up.
  let tabs = [];
  try {
    const meta = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.historySheetId)}`,
      {
        headers: { authorization: `Bearer ${ownerAccess}` },
        params: { fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))" },
        timeout: 30000,
      }
    );
    tabs = (meta.data?.sheets || []).map(s => ({
      title: s.properties?.title,
      gid: s.properties?.sheetId,
      rows: s.properties?.gridProperties?.rowCount,
      cols: s.properties?.gridProperties?.columnCount,
    }));
  } catch(e){ tabs = [{ error: e.message }]; }

  const range = `${cfg.pairsTab}!A1:R20000`;
  let rows = [], readError = null;
  try {
    rows = await sheetsGetValues({ accessToken: ownerAccess, spreadsheetId: cfg.historySheetId, range });
  } catch(e){ readError = e.message; }

  // Full-width scan: find where data actually sits (col index of non-empty cells per row).
  let wide = [];
  try {
    const w = await sheetsGetValues({ accessToken: ownerAccess, spreadsheetId: cfg.historySheetId, range: `${cfg.pairsTab}!A1:AZ60` });
    wide = w.map((r, i) => {
      const filled = [];
      (r || []).forEach((v, c) => { if(String(v ?? "").trim() !== "") filled.push(c); });
      return { row: i + 1, cells: (r || []).length, filledCols: filled.slice(0, 20), first: filled.length ? String(r[filled[0]]).slice(0, 50) : "" };
    }).filter(x => x.cells > 0);
  } catch(e){ wide = [{ error: e.message }]; }
  const all = readError ? [] : await readAllPairs({ accessToken: ownerAccess, cfg });
  json(res, 200, {
    ok: true,
    pairsTab: cfg.pairsTab,
    historySheetId: cfg.historySheetId,
    tabs,
    range,
    readError,
    wide,
    rawRowCount: rows.length,
    sampleRows: rows.slice(0, 30).map((r, i) => [i + 1, ...(r || []).slice(0, 4).map(v => JSON.stringify(String(v).slice(0, 60)))]),
    parsedPairs: all.length,
    rowIds: all.map(p => p.rowId),
    directions: all.map(p => p.direction),
  });
}

async function handleCron({ req, res, cfg }){
  if(!cronAuthorized(req)){
    json(res, 401, { ok: false, error: "Unauthorized cron request" });
    return;
  }

  let debug = req.query?.debug;
  if(!debug && req.url){
    try { debug = new URL(req.url, "http://x").searchParams.get("debug"); } catch {}
  }
  if(debug === "pairs") return await handleDebug({ res, cfg });
  if(debug === "cleanpairs"){
    // One-time admin cleanup: wipe every data row in the Pairs tab (keeps the
    // header) — used to clear rows that values.append shifted into the wrong
    // columns. Pairs must be re-saved from the UI afterwards.
    const ownerRefresh2 = process.env.SYNC_OWNER_REFRESH_TOKEN;
    if(!ownerRefresh2) return json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env" });
    const ownerAccess2 = await refreshAccessToken(ownerRefresh2);
    await sheetsClear({
      accessToken: ownerAccess2,
      spreadsheetId: cfg.historySheetId,
      range: `${cfg.pairsTab}!A2:AZ1024`,
    });
    return json(res, 200, { ok: true, cleaned: true, range: `${cfg.pairsTab}!A2:AZ1024` });
  }

  const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
  if(!ownerRefresh){
    json(res, 400, { ok: false, error: "Missing SYNC_OWNER_REFRESH_TOKEN env. Cron mode needs an owner refresh token to read pairs." });
    return;
  }

  const ownerAccess = await refreshAccessToken(ownerRefresh);
  const allActive = await readActiveCronPairs({ accessToken: ownerAccess, cfg });
  const secret = mustEnv("SYNC_SECRET");

  const now = Date.now();
  const due = allActive.filter(p => isDue(p, now));
  const skipped = allActive.length - due.length;

  const results = [];
  for(const p of due){
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

  // Stay quiet on idle ticks — only ping Lark when something actually ran.
  if(results.length > 0){
    const { ok, fail, total } = summarizeBatch(results);
    await notifyLarkBot({
      title: fail > 0 ? `⚠️ Cron sync — ${fail}/${total} failed` : `✅ Cron sync — ${ok}/${total} ok`,
      success: fail === 0,
      lines: results.map(r => resultLine(r)),
    });
  }

  const kolSplit = await runKolSplitStep();

  json(res, 200, { ok: true, mode: "cron", processed: results.length, skipped, results, kolSplit });
}

// "Run now" from the Cron Manager: run one saved pair immediately, ignoring its
// interval. Uses the owner token to read the pair + its own encrypted token,
// so it works regardless of who is logged in.
async function handleRunRow({ res, cfg, rowId }){
  const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
  if(!ownerRefresh) throw new Error("Missing SYNC_OWNER_REFRESH_TOKEN env");
  const secret = mustEnv("SYNC_SECRET");

  const ownerAccess = await refreshAccessToken(ownerRefresh);
  const p = await findPairByRowId({ accessToken: ownerAccess, cfg, rowId });
  if(!p) throw new Error(`No pair at row ${rowId}`);
  if(!p.refreshEnc) throw new Error("Pair has no stored credentials");

  const pairRefresh = decryptText(p.refreshEnc, secret);
  const accessToken = await refreshAccessToken(pairRefresh);
  const user = p.user || "manual";

  try{
    const r = await runOne({ accessToken, cfg, pair: { ...p, refreshToken: pairRefresh, userEmail: user } });
    await updateLastSync({ accessToken, cfg, rowId: p.rowId });
    await recordResult({ accessToken, cfg, pair: p, user, result: r });
    json(res, 200, { ok: true, processed: 1, results: [{ pair: p.sheetUrl, status: "success", ...pickResultFields(r) }] });
  }catch(e){
    await recordResult({ accessToken, cfg, pair: p, user, error: e });
    json(res, 200, { ok: true, processed: 1, results: [{ pair: p.sheetUrl, status: "error", error: e.message }] });
  }
}

async function handleManual({ req, res, cfg }){
  const body = req.body || {};

  // Cron Manager "Run now": run a single saved pair by its row id.
  const runRowId = parseInt(body.runRowId, 10);
  if(runRowId) return await handleRunRow({ res, cfg, rowId: runRowId });

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
    if(req.method === "GET")  return await handleCron({ req, res, cfg });
    if(req.method === "POST") return await handleManual({ req, res, cfg });
    methodNotAllowed(res);
  }catch(e){
    errorResponse(res, e);
  }
}
