import axios from "axios";
import { withBackoff } from "../retry.js";
import { getTenantAccessToken, authHeader, tableUrl, assertOk } from "./auth.js";

export async function larkListFields({ baseId, tableId }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.get(tableUrl(baseId, tableId, "/fields"), {
    headers: authHeader(token),
    params: { page_size: 100 },
    timeout: 30000,
  }), "larkListFields");
  return r.data?.data?.items || [];
}

export async function larkCreateField({ baseId, tableId, fieldName, fieldType = 1 }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.post(tableUrl(baseId, tableId, "/fields"),
    { field_name: fieldName, type: fieldType },
    { headers: authHeader(token), timeout: 30000 }
  ), "larkCreateField");
  assertOk(r.data, "Lark create field");
  return r.data?.data?.field;
}

export async function larkEnsureFields({ baseId, tableId, fieldNames }){
  const existing = await larkListFields({ baseId, tableId });
  const existingNames = new Set(existing.map(f => f.field_name));
  const created = [];
  for(const name of fieldNames){
    if(!existingNames.has(name)){
      await larkCreateField({ baseId, tableId, fieldName: name });
      created.push(name);
    }
  }
  return { existing: existingNames.size, created };
}
