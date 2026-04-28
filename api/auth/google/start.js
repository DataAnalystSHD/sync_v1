import { errorResponse, originFromReq } from "../../_lib/http.js";
import { getConfig, mustEnv } from "../../_lib/config.js";
import { signState } from "../../_lib/crypto.js";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/spreadsheets",
];

function buildAuthUrl({ clientId, redirectUri, state, hd }){
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("hd", hd);
  url.searchParams.set("state", state);
  return url.toString();
}

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    const clientId    = mustEnv("GOOGLE_CLIENT_ID");
    const secret      = mustEnv("SYNC_SECRET");
    const origin      = originFromReq(req);
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${origin}/api/auth/google/callback`;
    const state       = signState({ t: Date.now(), o: origin }, secret);

    res.statusCode = 302;
    res.setHeader("location", buildAuthUrl({ clientId, redirectUri, state, hd: cfg.allowedDomain }));
    res.end();
  }catch(e){
    errorResponse(res, e);
  }
}
