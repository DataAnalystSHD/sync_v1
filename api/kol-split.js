// Scheduled endpoint: split the KOL 2026 Base into New/Old KOL Lark Sheet tabs.
// Intended to be hit once a day by Vercel Cron or cron-job.org.
//
//   GET /api/kol-split               — run the split (rebuild both tabs)
//   GET /api/kol-split?dry=1          — read + classify only, no writes
//
// Protected by CRON_SECRET when set (same convention as /api/sync):
//   Authorization: Bearer <CRON_SECRET>   (Vercel Cron sends this automatically)
//   or  ?key=<CRON_SECRET>                (external cron)
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { runKolSplit } from "./_services/sync/kol-split.js";
import { notifyLarkBot } from "./_lib/lark/notify.js";

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

function queryFlag(req, name){
  if(req.query?.[name] !== undefined) return req.query[name];
  if(req.url){
    try { return new URL(req.url, "http://x").searchParams.get(name); } catch {}
  }
  return null;
}

export default async function handler(req, res){
  try{
    if(req.method !== "GET") return methodNotAllowed(res);
    if(!cronAuthorized(req)) return json(res, 401, { ok: false, error: "Unauthorized" });

    const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());
    const dryRun = truthy(queryFlag(req, "dry"));
    const force  = truthy(queryFlag(req, "force"));
    const result = await runKolSplit({ dryRun, force, log: (m) => console.log("[kol-split]", m) });

    // Only ping Lark when the tabs were actually rewritten — stay quiet on the
    // frequent unchanged polls.
    if(!dryRun && result.changed){
      await notifyLarkBot({
        title: `✅ KOL split — New ${result.newCount} / Old ${result.oldCount}`,
        success: true,
        lines: [
          `New KOL: **${result.newCount}** rows`,
          `Old KOL: **${result.oldCount}** rows`,
          `Skipped (no Promote Method): ${result.skipped}`,
        ],
      });
    }

    json(res, 200, { ok: true, ...result });
  }catch(e){
    await notifyLarkBot({ title: "❌ KOL split failed", success: false, lines: [e?.message || String(e)] });
    errorResponse(res, e);
  }
}
