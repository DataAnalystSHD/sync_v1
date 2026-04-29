// Lark Bitable field type IDs (from open-platform docs)
export const FIELD_TYPE = {
  TEXT:           1,
  NUMBER:         2,
  SINGLE_SELECT:  3,
  MULTI_SELECT:   4,
  DATETIME:       5,
  CHECKBOX:       7,
  USER:          11,
  PHONE:         13,
  URL:           15,
  ATTACHMENT:    17,
  SINGLE_LINK:   18,
  LOOKUP:        19,
  FORMULA:       20,
  DUPLEX_LINK:   21,
  LOCATION:      22,
  GROUP_CHAT:    23,
  CREATED_TIME:  1001,
  MODIFIED_TIME: 1002,
  CREATED_USER:  1003,
  MODIFIED_USER: 1004,
  AUTO_NUMBER:   1005,
};

const DATE_TYPES   = new Set([FIELD_TYPE.DATETIME, FIELD_TYPE.CREATED_TIME, FIELD_TYPE.MODIFIED_TIME]);
const USER_TYPES   = new Set([FIELD_TYPE.USER, FIELD_TYPE.CREATED_USER, FIELD_TYPE.MODIFIED_USER]);
const LINK_TYPES   = new Set([FIELD_TYPE.SINGLE_LINK, FIELD_TYPE.DUPLEX_LINK]);

function joinTextArr(arr){
  if(!Array.isArray(arr)) return "";
  return arr.map(x => (typeof x === "object" ? (x?.text || x?.name || "") : String(x ?? ""))).filter(Boolean).join(", ");
}

function formatTimestamp(v){
  const ms = Number(v);
  if(!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

/**
 * Format a Bitable cell value into a string suitable for a spreadsheet cell.
 * Handles the common Bitable field types so dates / numbers / selects /
 * users / attachments / urls don't end up as `[object Object]`.
 */
export function formatBitableValue(value, type){
  if(value === null || value === undefined) return "";

  if(type === FIELD_TYPE.NUMBER){
    return typeof value === "number" ? value : String(value);
  }

  if(type === FIELD_TYPE.CHECKBOX){
    return value ? "TRUE" : "FALSE";
  }

  if(DATE_TYPES.has(type)){
    return formatTimestamp(value);
  }

  if(type === FIELD_TYPE.SINGLE_SELECT){
    if(typeof value === "object") return value?.text || value?.name || "";
    return String(value);
  }

  if(type === FIELD_TYPE.MULTI_SELECT){
    return joinTextArr(value);
  }

  if(USER_TYPES.has(type)){
    if(Array.isArray(value)) return value.map(u => u?.name || u?.en_name || u?.id || "").filter(Boolean).join(", ");
    if(typeof value === "object") return value?.name || value?.en_name || value?.id || "";
    return String(value);
  }

  if(type === FIELD_TYPE.URL){
    if(Array.isArray(value)) return value.map(v => v?.link || v?.text || "").filter(Boolean).join(", ");
    if(typeof value === "object") return value?.link || value?.text || "";
    return String(value);
  }

  if(type === FIELD_TYPE.ATTACHMENT){
    if(Array.isArray(value)) return value.map(a => a?.url || a?.name || "").filter(Boolean).join(", ");
    return "";
  }

  if(LINK_TYPES.has(type)){
    if(Array.isArray(value)) return joinTextArr(value);
    if(typeof value === "object"){
      return joinTextArr(value.text_arr) || joinTextArr(value.link_record_ids) || value.text || "";
    }
    return String(value);
  }

  if(type === FIELD_TYPE.LOCATION && typeof value === "object"){
    return value?.address || value?.full_address || value?.name || "";
  }

  if(type === FIELD_TYPE.GROUP_CHAT && typeof value === "object"){
    return value?.name || value?.chat_id || "";
  }

  if(type === FIELD_TYPE.FORMULA || type === FIELD_TYPE.LOOKUP){
    if(Array.isArray(value)) return joinTextArr(value);
    if(typeof value === "object") return value?.text || JSON.stringify(value);
    return String(value);
  }

  // Generic fallback for Text, Phone, AutoNumber, and unknown types.
  if(typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function buildFieldTypeMap(fields){
  const map = new Map();
  for(const f of fields || []){
    if(f?.field_name) map.set(f.field_name, f.type);
  }
  return map;
}
