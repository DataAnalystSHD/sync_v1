import axios from "axios";
import { withBackoff } from "../retry.js";
import { getConfig } from "../config.js";
import { colIndexToA1 } from "../urls.js";
import { getTenantAccessToken, authHeader, assertOk } from "./auth.js";


/**
 * Normalize a Lark Sheet cell value to a plain display string.
 *
 * Lark returns rich-content cells (hyperlinks, mailto, mentions, multi-run
 * rich text) as an array of segments like
 *   [{ text: "user@x.com", link: "mailto:user@x.com", type: "url" }]
 * — JSON.stringify on that array would leak the structure into downstream
 * sheets/Bitable. We extract the user-facing `text` from each segment so
 * the value becomes the same string the user sees in Lark Sheet.
 */
export function cellTextValue(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "string")  return v;
  if(typeof v === "number")  return String(v);
  if(typeof v === "boolean") return String(v);
  if(Array.isArray(v)){
    return v.map(seg => {
      if(seg === null || seg === undefined) return "";
      if(typeof seg === "string") return seg;
      if(typeof seg === "object"){
        if(typeof seg.text === "string") return seg.text;
        if(typeof seg.link === "string") return seg.link;
        return "";
      }
      return String(seg);
    }).join("");
  }
  if(typeof v === "object"){
    if(typeof v.text === "string") return v.text;
    if(typeof v.link === "string") return v.link;
    return "";
  }
  return String(v);
}

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

// Write `rows` (array of arrays) starting at 1-based `startRow`. Lark caps a
// single values write at 100 COLUMNS, so wide data is split into column bands
// (and large data into row chunks). Safe for narrow data too (one band).
export async function batchUpdateBanded({ ssToken, sheetId, startRow, rows, rowChunk = 1000, maxCols = 100 }){
  if(!rows || rows.length === 0) return;
  const width = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
  if(width === 0) return;
  for(let c = 0; c < width; c += maxCols){
    const cEnd = Math.min(c + maxCols, width);
    const colStart = colIndexToA1(c);
    const colEnd   = colIndexToA1(cEnd - 1);
    for(let i = 0; i < rows.length; i += rowChunk){
      const part = rows.slice(i, i + rowChunk).map(r => (r || []).slice(c, cEnd));
      const s = startRow + i;
      await batchUpdateValues({
        ssToken,
        ranges: [{ range: `${sheetId}!${colStart}${s}:${colEnd}${s + part.length - 1}`, values: part }],
      });
    }
  }
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

// Delete columns [startIndex, endIndex] (1-based, inclusive) — used to trim
// stale columns when a Replace sync writes fewer columns than the sheet held.
export async function deleteColumns({ ssToken, sheetId, startIndex, endIndex }){
  const token = await getTenantAccessToken();
  const r = await withBackoff(() => axios.delete(v2(ssToken, "/dimension_range"), {
    headers: authHeader(token),
    data: { dimension: { sheetId, majorDimension: "COLUMNS", startIndex, endIndex } },
    timeout: 30000,
  }), "larkSheetDeleteColumns");
  assertOk(r.data, "Lark sheet dimension_range delete (columns)");
  return r.data;
}
