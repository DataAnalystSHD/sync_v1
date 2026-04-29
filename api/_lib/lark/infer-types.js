import { FIELD_TYPE } from "./field-types.js";

const ISO_DATE_RE   = /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}(\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?)?$/i;
const DASH_DATE_RE  = /^\d{1,2}-\d{1,2}-\d{4}$/;
const NUMBER_RE     = /^-?\d+(\.\d+)?$/;
const INT_RE        = /^-?\d+$/;
const BOOL_RE       = /^(true|false|yes|no)$/i;
const TRUTHY_RE     = /^(true|yes)$/i;
const LEADING_ZERO  = /^-?0\d/;          // 0812345678, 0001 → keep as text
const MAX_NUM_LEN   = 16;                // beyond JS safe integer territory

function looksLikeNumber(s){
  if(LEADING_ZERO.test(s)) return false;
  if(!NUMBER_RE.test(s))   return false;
  if(s.length > MAX_NUM_LEN && !s.includes(".")) return false;
  return true;
}

function looksLikeDate(s){
  if(!ISO_DATE_RE.test(s) && !SLASH_DATE_RE.test(s) && !DASH_DATE_RE.test(s)) return false;
  return Number.isFinite(Date.parse(s));
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
 *
 * Date-shaped strings are intentionally left as Text (not DateTime) —
 * the user prefers their day/month/year cells to stay readable as
 * literal strings rather than be reformatted by Lark's date renderer.
 */
export function inferType(samples){
  const xs = clean(samples);
  if(xs.length === 0) return FIELD_TYPE.TEXT;

  if(xs.every(v => BOOL_RE.test(v))) return FIELD_TYPE.CHECKBOX;
  if(xs.every(looksLikeNumber))      return FIELD_TYPE.NUMBER;
  if(xs.every(looksLikeDate))        return FIELD_TYPE.TEXT;
  return FIELD_TYPE.TEXT;
}

/**
 * Pick the right Lark Bitable `property` for a freshly inferred field.
 * The most useful case is Number columns where every sample is an
 * integer — we tell Lark to format it as "0" so the cells don't render
 * as "1234.0" once the field defaults to one decimal place.
 */
export function inferProperty(samples, type){
  if(type === FIELD_TYPE.NUMBER){
    const xs = clean(samples);
    if(xs.length > 0 && xs.every(v => INT_RE.test(v))){
      return { formatter: "0" };
    }
  }
  if(type === FIELD_TYPE.DATETIME){
    return { date_formatter: "yyyy/MM/dd HH:mm", auto_fill: false };
  }
  return undefined;
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
