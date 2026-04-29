import { FIELD_TYPE } from "./field-types.js";

const ISO_DATE_RE  = /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_RE    = /^-?\d+(\.\d+)?$/;
const BOOL_RE      = /^(true|false|yes|no)$/i;
const TRUTHY_RE    = /^(true|yes)$/i;
const LEADING_ZERO = /^-?0\d/;          // 0812345678, 0001 → keep as text
const MAX_NUM_LEN  = 16;                // beyond JS safe integer territory

function looksLikeNumber(s){
  if(LEADING_ZERO.test(s)) return false;
  if(!NUMBER_RE.test(s))   return false;
  if(s.length > MAX_NUM_LEN && !s.includes(".")) return false;
  return true;
}

function clean(samples){
  return (samples || [])
    .map(v => (v === null || v === undefined ? "" : String(v).trim()))
    .filter(v => v !== "");
}

/**
 * Sample some Sheet/Lark Sheet values and pick the strictest Lark Bitable
 * field type that matches every non-empty sample. Falls back to Text when
 * the column is mixed or empty so we never lose data.
 */
export function inferType(samples){
  const xs = clean(samples);
  if(xs.length === 0) return FIELD_TYPE.TEXT;

  if(xs.every(v => BOOL_RE.test(v)))     return FIELD_TYPE.CHECKBOX;
  if(xs.every(v => ISO_DATE_RE.test(v))) return FIELD_TYPE.DATETIME;
  if(xs.every(looksLikeNumber))          return FIELD_TYPE.NUMBER;
  return FIELD_TYPE.TEXT;
}

/**
 * Convert a string value from a Sheet cell into the native shape Lark's
 * batch_create endpoint expects for the given field type. Returns
 * `undefined` when the cell is empty or can't be parsed for the target
 * type — callers should skip undefined fields entirely so Lark doesn't
 * reject the whole record because of one bad cell.
 */
export function convertForLark(value, type){
  if(value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if(s === "") return undefined;

  if(type === FIELD_TYPE.NUMBER){
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  if(type === FIELD_TYPE.DATETIME){
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : undefined;
  }
  if(type === FIELD_TYPE.CHECKBOX){
    return TRUTHY_RE.test(s);
  }
  return s;
}
