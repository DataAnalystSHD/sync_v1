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

/**
 * Make sure every requested field exists in the table.
 *
 * Accepts either an array of field names (legacy) or an array of
 * { name, type } objects. Returns a typeMap (field_name → type) for the
 * full table after creation, so callers can convert record values.
 */
export async function larkEnsureFields({ baseId, tableId, fields, fieldNames }){
  const requested = (fields || fieldNames || []).map(f =>
    typeof f === "string" ? { name: f, type: 1 } : f
  );

  const existing = await larkListFields({ baseId, tableId });
  const typeMap  = new Map(existing.map(f => [f.field_name, f.type]));
  const created  = [];

  for(const f of requested){
    if(!typeMap.has(f.name)){
      const newField = await larkCreateField({
        baseId, tableId,
        fieldName: f.name,
        fieldType: f.type || 1,
      });
      typeMap.set(f.name, newField?.type || f.type || 1);
      created.push(f.name);
    }
  }

  return { typeMap, created, existing: existing.length };
}
