import axios from "axios";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

function valuesUrl(spreadsheetId, range, suffix = ""){
  return `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
}

function authHeader(accessToken){
  return { authorization: `Bearer ${accessToken}` };
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
