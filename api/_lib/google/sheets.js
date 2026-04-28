import axios from "axios";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function valuesUrl(spreadsheetId, range, suffix = ""){
  return `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

function authHeader(accessToken){
  return { authorization: `Bearer ${accessToken}` };
}

export function quoteSheetName(name){
  if(!name) return "";
  return `'${String(name).replace(/'/g, "''")}'`;
}

export async function getSheetNameByGid({ accessToken, spreadsheetId, gid }){
  const url = `${API_BASE}/${encodeURIComponent(spreadsheetId)}`;
  const r = await axios.get(url, {
    headers: authHeader(accessToken),
    params: { fields: "sheets(properties(sheetId,title))" },
    timeout: 30000,
  });
  const sheets = r.data?.sheets || [];
  if(sheets.length === 0) throw new Error("Google spreadsheet has no sheets");
  if(!gid) return sheets[0].properties.title;
  const target = sheets.find(s => String(s.properties.sheetId) === String(gid));
  if(!target) throw new Error(`Google Sheet has no tab with gid=${gid}`);
  return target.properties.title;
}

export async function sheetsGetValues({ accessToken, spreadsheetId, range }){
  const r = await axios.get(valuesUrl(spreadsheetId, range), {
    headers: authHeader(accessToken),
    timeout: 30000,
  });
  return r.data.values || [];
}

export async function sheetsClear({ accessToken, spreadsheetId, range }){
  const r = await axios.post(valuesUrl(spreadsheetId, range, ":clear"), {}, {
    headers: authHeader(accessToken),
    timeout: 30000,
  });
  return r.data;
}

export async function sheetsUpdate({ accessToken, spreadsheetId, range, values }){
  const r = await axios.put(valuesUrl(spreadsheetId, range), { majorDimension: "ROWS", values }, {
    headers: { ...authHeader(accessToken), "content-type": "application/json" },
    params: { valueInputOption: "USER_ENTERED" },
    timeout: 45000,
  });
  return r.data;
}

export async function sheetsAppend({ accessToken, spreadsheetId, range, values }){
  const r = await axios.post(valuesUrl(spreadsheetId, range, ":append"), { majorDimension: "ROWS", values: [values] }, {
    headers: authHeader(accessToken),
    params: { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
    timeout: 30000,
  });
  return r.data;
}
