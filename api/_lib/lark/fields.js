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

export async function larkCreateField({ baseId, tableId, fieldName, fieldType = 1, property }){
  const token = await getTenantAccessToken();
  const body = { field_name: fieldName, type: fieldType };
  if(property) body.property = property;
  const r = await withBackoff(() => axios.post(tableUrl(baseId, tableId, "/fields"),
    body,
    { headers: authHeader(token), timeout: 30000 }
  ), "larkCreateField");
  assertOk(r.data, "Lark create field");
  return r.data?.data?.field;
}

export async function larkDeleteField({ baseId, tableId, fieldId }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.delete(tableUrl(baseId, tableId, `/fields/${fieldId}`), {
    headers: authHeader(token), timeout: 30000,
  }), "larkDeleteField");
  assertOk(r.data, "Lark delete field");
  return r.data;
}

const normName = s => String(s || "").trim().toLowerCase();

/**
 * Make sure every requested field exists in the table.
 *
 * Accepts either an array of field names (legacy) or an array of
 * { name, type } objects. Lark Bitable enforces field-name uniqueness
 * case-insensitively (and ignoring leading/trailing whitespace), so a
 * source header like "date" against an existing "Date" must reuse the
 * existing field instead of creating a duplicate — otherwise Lark fails
 * with code=1254014 FieldNameDuplicated.
 *
 * Returns:
 *   typeMap — keyed by the *requested* name (what callers wrote in their
 *             record objects), so convertForLark can pick the right type
 *   nameMap — requested name → actual Bitable field name (for callers
 *             that need to push records with the canonical key)
 *   created — names of fields created in this run
 */
export async function larkEnsureFields({ baseId, tableId, fields, fieldNames }){
  const requested = (fields || fieldNames || []).map(f =>
    typeof f === "string" ? { name: f, type: 1 } : f
  );

  const existing = await larkListFields({ baseId, tableId });
  const byNorm = new Map(existing.map(f => [normName(f.field_name), f]));
  const typeMap = new Map(existing.map(f => [f.field_name, f.type]));
  const nameMap = new Map();
  const created = [];

  for(const f of requested){
    const hit = byNorm.get(normName(f.name));
    if(hit){
      nameMap.set(f.name, hit.field_name);
      typeMap.set(f.name, hit.type);
      continue;
    }
    const newField = await larkCreateField({
      baseId, tableId,
      fieldName: f.name,
      fieldType: f.type || 1,
      property: f.property,
    });
    const actualName = newField?.field_name || f.name;
    const actualType = newField?.type || f.type || 1;
    byNorm.set(normName(actualName), { field_name: actualName, type: actualType });
    typeMap.set(f.name, actualType);
    nameMap.set(f.name, actualName);
    created.push(actualName);
  }

  return { typeMap, nameMap, created, existing: existing.length };
}
