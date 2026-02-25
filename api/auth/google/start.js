import crypto from "crypto";
import { json, mustEnv, originFromReq, getConfig } from "../../_util.js";

function signState(payload, secret){
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const clientId = mustEnv("GOOGLE_CLIENT_ID");
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${originFromReq(req)}/api/auth/google/callback`;
    const secret = mustEnv("SYNC_SECRET");

    const state = signState({
      t: Date.now(),
      o: originFromReq(req)
    }, secret);

    const scope = [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/spreadsheets"
    ].join(" ");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("hd", cfg.allowedDomain);

    authUrl.searchParams.set("state", state);

    res.statusCode = 302;
    res.setHeader("location", authUrl.toString());
    res.end();
  }catch(e){
    json(res, 500, { ok:false, error: e.message });
  }
}