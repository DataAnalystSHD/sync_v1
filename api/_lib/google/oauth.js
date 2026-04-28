import axios from "axios";
import { mustEnv } from "../config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

async function postForm(body){
  const r = await axios.post(TOKEN_URL, body.toString(), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  return r.data;
}

export async function exchangeCodeForTokens({ code, redirectUri }){
  const body = new URLSearchParams({
    code,
    client_id: mustEnv("GOOGLE_CLIENT_ID"),
    client_secret: mustEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return await postForm(body);
}

export async function refreshAccessToken(refreshToken){
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: mustEnv("GOOGLE_CLIENT_ID"),
    client_secret: mustEnv("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });
  const data = await postForm(body);
  return data.access_token;
}

export async function verifyIdToken(idToken){
  const r = await axios.get(TOKENINFO_URL, {
    params: { id_token: idToken },
    timeout: 15000,
  });
  return r.data;
}
