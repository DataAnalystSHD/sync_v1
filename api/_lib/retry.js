import { getConfig } from "./config.js";

export function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

export function chunk(arr, size){
  const out = [];
  for(let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isTransient(err){
  const status = err?.response?.status || 0;
  const msg = String(err?.message || "");
  return (
    status === 429 ||
    status === 408 ||
    (status >= 500 && status <= 599) ||
    /timeout|ECONNRESET|EAI_AGAIN|socket hang up/i.test(msg)
  );
}

function describeError(err, label){
  const status = err?.response?.status;
  const data = err?.response?.data;
  if(data && typeof data === "object"){
    const code = data.code ?? data.error_code;
    const msg  = data.msg  ?? data.error_msg ?? data.error_description ?? data.error;
    if(code != null || msg){
      return `[${label}] HTTP ${status ?? "?"} code=${code ?? "?"} msg=${msg ?? "?"}`;
    }
  }
  if(status) return `[${label}] HTTP ${status} ${err?.message || ""}`.trim();
  return `[${label}] ${err?.message || String(err)}`;
}

export async function withBackoff(fn, label){
  const max = getConfig().larkRetries;
  let lastErr = null;
  for(let i = 0; i < max; i++){
    try{
      return await fn();
    }catch(e){
      lastErr = e;
      if(!isTransient(e) || i === max - 1) break;
      const wait = Math.min(30000, 600 * Math.pow(2, i) + Math.random() * 400);
      console.warn(`[${label}] retry ${i+1}/${max} wait=${Math.round(wait)}ms status=${e?.response?.status || 0}`);
      await sleep(wait);
    }
  }
  const wrapped = new Error(describeError(lastErr, label));
  wrapped.cause = lastErr;
  wrapped.status = lastErr?.response?.status;
  wrapped.larkCode = lastErr?.response?.data?.code;
  throw wrapped;
}
