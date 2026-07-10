// Value filters: sync only the rows whose Single/Multi-Select field matches one
// of the chosen option values (e.g. Platform ∈ {Tiktok, Facebook}). Stored on
// the pair as JSON. Empty = no filter (all rows).
//
//   filters = [{ field: "Platform", values: ["Tiktok","Facebook"] }, ...]
//
// Semantics: AND across filters, OR within a filter's values. A filter with an
// empty `values` array is ignored (so a half-built filter never drops all rows).
import { FIELD_TYPE, formatBitableValue } from "./lark/field-types.js";

export function parseFilters(raw){
  let v = raw;
  if(typeof raw === "string"){
    const s = raw.trim();
    if(!s) return [];
    try { v = JSON.parse(s); } catch { return []; }
  }
  if(!Array.isArray(v)) return [];
  return v
    .filter(f => f && typeof f.field === "string" && Array.isArray(f.values))
    .map(f => ({ field: f.field, values: f.values.map(String) }))
    .filter(f => f.values.length > 0);
}

// The set of string values a record holds for one field (handles single/multi
// select and falls back to the formatted text for anything else).
export function fieldValueSet(raw, type){
  if(raw === null || raw === undefined) return new Set();
  if(type === FIELD_TYPE.MULTI_SELECT){
    const arr = Array.isArray(raw) ? raw : [raw];
    return new Set(arr.map(x => (typeof x === "object" ? (x?.text || x?.name || "") : String(x))).filter(Boolean));
  }
  if(type === FIELD_TYPE.SINGLE_SELECT){
    const v = typeof raw === "object" ? (raw?.text || raw?.name || "") : String(raw);
    return v ? new Set([v]) : new Set();
  }
  const s = formatBitableValue(raw, type);
  return s ? new Set([s]) : new Set();
}

// Keep only records passing every active filter. `typeMap` is name → field type.
export function applyRecordFilters(items, filters, typeMap){
  const active = parseFilters(filters);
  if(active.length === 0) return items;
  return (items || []).filter(it => {
    const f = it.fields || {};
    return active.every(flt => {
      const have = fieldValueSet(f[flt.field], typeMap?.get(flt.field));
      return flt.values.some(v => have.has(v));
    });
  });
}
