import crypto from "crypto";
import { json, mustEnv, getConfig, exchangeCodeForTokens, verifyIdToken, originFromReq } from "../../_util.js";

function verifyState(state, secret){
  const [body, sig] = String(state||"").split(".");
  if(!body || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if(expected !== sig) return null;
  try{
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  }catch{
    return null;
  }
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const secret = mustEnv("SYNC_SECRET");

    const code = req.query?.code;
    const stateRaw = req.query?.state;

    if(!code) throw new Error("Missing code");
    const st = verifyState(stateRaw, secret);
    if(!st) throw new Error("Invalid state");

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${originFromReq(req)}/api/auth/google/callback`;
    const tok = await exchangeCodeForTokens({ code, redirectUri });

    const idInfo = tok.id_token ? await verifyIdToken(tok.id_token) : null;
    const email = idInfo?.email || "";
    const hd = idInfo?.hd || "";
    if(!email) throw new Error("No email in id_token");
    if(hd !== cfg.allowedDomain) throw new Error(`Domain not allowed: ${hd}`);

    // refresh_token only returned when prompt=consent; may still be missing
    const refreshToken = tok.refresh_token || "";

    const payload = {
      type: "shd_google_oauth",
      ok: true,
      email,
      refresh_token: refreshToken
    };

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body>
<script>
  (function(){
    const data = ${JSON.stringify(payload)};
    try {
      if (window.opener) {
        window.opener.postMessage(data, "*");
      }
    } catch (e) {}
    window.close();
  })();
</script>
<p>Login complete. You can close this window.</p>
</body></html>`);
  }catch(e){
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><body>
<script>
  (function(){
    const data = { type:"shd_google_oauth", ok:false, error:${JSON.stringify(e.message)} };
    try { if(window.opener) window.opener.postMessage(data, "*"); } catch(e){}
    window.close();
  })();
</script>
<p>Login failed: ${String(e.message).replace(/</g,"&lt;")}</p>
</body></html>`);
  }
}