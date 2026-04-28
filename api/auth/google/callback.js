import { originFromReq } from "../../_lib/http.js";
import { getConfig, mustEnv } from "../../_lib/config.js";
import { verifyState } from "../../_lib/crypto.js";
import { exchangeCodeForTokens, verifyIdToken } from "../../_lib/google/oauth.js";

function htmlResponse(res, payload){
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body>
<script>
  (function(){
    const data = ${JSON.stringify(payload)};
    try { if (window.opener) window.opener.postMessage(data, "*"); } catch(e){}
    window.close();
  })();
</script>
<p>${payload.ok ? "Login complete. You can close this window." : "Login failed: " + String(payload.error || "").replace(/</g, "&lt;")}</p>
</body></html>`);
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const secret = mustEnv("SYNC_SECRET");

    const code = req.query?.code;
    const stateRaw = req.query?.state;
    if(!code) throw new Error("Missing code");
    if(!verifyState(stateRaw, secret)) throw new Error("Invalid state");

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${originFromReq(req)}/api/auth/google/callback`;
    const tok = await exchangeCodeForTokens({ code, redirectUri });

    const idInfo = tok.id_token ? await verifyIdToken(tok.id_token) : null;
    const email = idInfo?.email || "";
    const hd    = idInfo?.hd || "";
    if(!email) throw new Error("No email in id_token");
    if(hd !== cfg.allowedDomain) throw new Error(`Domain not allowed: ${hd}`);

    htmlResponse(res, {
      type: "shd_google_oauth",
      ok: true,
      email,
      refresh_token: tok.refresh_token || "",
    });
  }catch(e){
    htmlResponse(res, { type: "shd_google_oauth", ok: false, error: e.message });
  }
}
