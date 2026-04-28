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
  throw lastErr;
}
