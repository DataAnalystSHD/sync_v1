import axios from "axios";
import { withBackoff } from "../retry.js";
import { getConfig } from "../config.js";
import { getTenantAccessToken, authHeader, assertOk } from "./auth.js";

function v2(ssToken, suffix = ""){
  const { larkApiBase } = getConfig();
  return `${larkApiBase}/open-apis/sheets/v2/spreadsheets/${ssToken}${suffix}`;
}

function v3(ssToken, suffix = ""){
  const { larkApiBase } = getConfig();
  return `${larkApiBase}/open-apis/sheets/v3/spreadsheets/${ssToken}${suffix}`;
}

export async function listSheets(ssToken){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.get(v3(ssToken, "/sheets/query"), {
    headers: authHeader(token), timeout: 30000,
  }), "larkSheetsQuery");
  assertOk(r.data, "Lark sheets/query");
  return r.data?.data?.sheets || [];
}

export async function getSheetMeta({ ssToken, sheetId }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.get(v3(ssToken, `/sheets/${sheetId}`), {
    headers: authHeader(token), timeout: 30000,
  }), "larkSheetMeta");
  assertOk(r.data, "Lark sheet meta");
  return r.data?.data?.sheet || null;
}

export async function getSheetValues({ ssToken, sheetId, range }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.get(v2(ssToken, `/values/${sheetId}!${range}`), {
    headers: authHeader(token),
    params: { dateTimeRenderOption: "FormattedString" },
    timeout: 30000,
  }), "larkSheetValuesGet");
  assertOk(r.data, "Lark sheet values get");
  return r.data?.data?.valueRange?.values || [];
}

export async function batchUpdateValues({ ssToken, ranges }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.post(v2(ssToken, "/values_batch_update"),
    { valueRanges: ranges },
    { headers: authHeader(token), timeout: 45000 }
  ), "larkSheetValuesBatchUpdate");
  assertOk(r.data, "Lark sheet values_batch_update");
  return r.data;
}

export async function deleteRows({ ssToken, sheetId, startIndex, endIndex }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.delete(v2(ssToken, "/dimension_range"), {
    headers: authHeader(token),
    data: { dimension: { sheetId, majorDimension: "ROWS", startIndex, endIndex } },
    timeout: 30000,
  }), "larkSheetDeleteRows");
  assertOk(r.data, "Lark sheet dimension_range delete");
  return r.data;
}
