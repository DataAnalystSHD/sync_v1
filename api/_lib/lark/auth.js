import axios from "axios";
import { getConfig, mustEnv } from "../config.js";

let cached = { token: "", exp: 0 };

export async function getTenantAccessToken(){
  const now = Date.now();
  if(cached.token && now < cached.exp - 60_000) return cached.token;

  const { larkApiBase } = getConfig();
  const r = await axios.post(`${larkApiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    app_id: mustEnv("LARK_APP_ID"),
    app_secret: mustEnv("LARK_APP_SECRET"),
  }, { timeout: 20000 });

  if(!r.data?.tenant_access_token) throw new Error("Lark token missing");
  cached.token = r.data.tenant_access_token;
  cached.exp   = now + (r.data.expire || 3600) * 1000;
  return cached.token;
}

export function authHeader(token){
  return { authorization: `Bearer ${token}` };
}

export function tableUrl(baseId, tableId, sub = ""){
  const { larkApiBase } = getConfig();
  return `${larkApiBase}/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}${sub}`;
}

export function assertOk(data, label){
  if(data?.code && data.code !== 0){
    throw new Error(`${label} code=${data.code} msg=${data.msg}`);
  }
}
