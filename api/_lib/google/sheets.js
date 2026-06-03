import axios from "axios";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function valuesUrl(spreadsheetId, range, suffix = ""){
  return `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

function authHeader(accessToken){
  return { authorization: `Bearer ${accessToken}` };
}

// Turn known, cryptic Google API errors into clear Thai guidance the user can
// act on. Returns null when the raw error has no friendly mapping.
function friendlyGoogleError(rawMsg){
  const m = String(rawMsg || "");
  if(/must not be an Office file|not supported for this document/i.test(m)){
    return "ไฟล์นี้เป็น Excel (.xlsx) ที่อัปโหลดขึ้น Drive ไม่ใช่ Google Sheet จริง — เปิดไฟล์แล้วเลือก File → Save as Google Sheets (หรือเปิด Drive Settings → ติ๊ก Convert uploads) แล้วใช้ URL ของไฟล์ Google Sheet ที่แปลงแล้ว";
  }
  if(/The caller does not have permission|PERMISSION_DENIED/i.test(m)){
    return "ไม่มีสิทธิ์เข้าถึง Google Sheet นี้ — ตรวจว่าได้ login ด้วยบัญชีที่มีสิทธิ์ (Viewer ขึ้นไป) และแชร์ไฟล์ให้บัญชีนั้นแล้ว";
  }
  if(/Requested entity was not found|Unable to parse range|NOT_FOUND/i.test(m)){
    return "หา Google Sheet หรือแท็บ/ช่วงข้อมูลที่ระบุไม่เจอ — ตรวจ URL และชื่อแท็บอีกครั้ง";
  }
  return null;
}

async function googleCall(label, fn){
  try {
    return await fn();
  } catch(e){
    const status = e?.response?.status;
    const data = e?.response?.data;
    const msg = data?.error?.message || data?.error_description || data?.error || e?.message || String(e);
    const code = data?.error?.code ?? data?.error?.status ?? "?";

    const friendly = friendlyGoogleError(msg);
    const wrapped = new Error(friendly || `[${label}] HTTP ${status ?? "?"} code=${code} msg=${msg}`);
    wrapped.cause = e;
    wrapped.status = status;
    throw wrapped;
  }
}

export function quoteSheetName(name){
  if(!name) return "";
  return `'${String(name).replace(/'/g, "''")}'`;
}

export async function getSheetNameByGid({ accessToken, spreadsheetId, gid }){
  const url = `${API_BASE}/${encodeURIComponent(spreadsheetId)}`;
  const r = await googleCall("googleGetSpreadsheet", () => axios.get(url, {
    headers: authHeader(accessToken),
    params: { fields: "sheets(properties(sheetId,title))" },
    timeout: 30000,
  }));
  const sheets = r.data?.sheets || [];
  if(sheets.length === 0) throw new Error("Google spreadsheet has no sheets");
  if(!gid) return sheets[0].properties.title;
  const target = sheets.find(s => String(s.properties.sheetId) === String(gid));
  if(!target) throw new Error(`Google Sheet has no tab with gid=${gid}`);
  return target.properties.title;
}

export async function sheetsGetValues({ accessToken, spreadsheetId, range }){
  const r = await googleCall("googleSheetValuesGet", () => axios.get(valuesUrl(spreadsheetId, range), {
    headers: authHeader(accessToken),
    timeout: 30000,
  }));
  return r.data.values || [];
}

export async function sheetsClear({ accessToken, spreadsheetId, range }){
  const r = await googleCall("googleSheetClear", () => axios.post(valuesUrl(spreadsheetId, range, ":clear"), {}, {
    headers: authHeader(accessToken),
    timeout: 30000,
  }));
  return r.data;
}

export async function sheetsUpdate({ accessToken, spreadsheetId, range, values }){
  const r = await googleCall("googleSheetUpdate", () => axios.put(valuesUrl(spreadsheetId, range), { majorDimension: "ROWS", values }, {
    headers: { ...authHeader(accessToken), "content-type": "application/json" },
    params: { valueInputOption: "USER_ENTERED" },
    timeout: 45000,
  }));
  return r.data;
}

export async function sheetsAppend({ accessToken, spreadsheetId, range, values }){
  const r = await googleCall("googleSheetAppend", () => axios.post(valuesUrl(spreadsheetId, range, ":append"), { majorDimension: "ROWS", values: [values] }, {
    headers: authHeader(accessToken),
    params: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
    timeout: 30000,
  }));
  return r.data;
}
