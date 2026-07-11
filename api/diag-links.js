// TEMPORARY diagnostic — inspect how hyperlinks are stored in a Google Sheet's
// cells so we can see why embedded links aren't being extracted.
//
//   POST { refreshToken, sheetUrl } → per-column link diagnosis for first 30 rows
//
// Reads the grid with EXTENDED fields (formattedValue, hyperlink, the =HYPERLINK
// formula, and rich-text run links) and reports which of those actually carries
// a link. Remove this file once the link issue is resolved.
import axios from "axios";
import { json, methodNotAllowed, errorResponse } from "./_lib/http.js";
import { refreshAccessToken } from "./_lib/google/oauth.js";
import { parseGoogleSheetUrl } from "./_lib/urls.js";
import { getSheetNameByGid, quoteSheetName } from "./_lib/google/sheets.js";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export default async function handler(req, res){
  try{
    if(req.method !== "POST") return methodNotAllowed(res);
    const body = req.body || {};
    const refreshToken = body.refreshToken || body.refresh_token || "";
    if(!refreshToken) throw new Error("Missing refreshToken");
    const { id, gid } = parseGoogleSheetUrl(body.sheetUrl || "");
    if(!id) throw new Error("Bad sheetUrl");

    const accessToken = await refreshAccessToken(refreshToken);
    const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: id, gid });
    const tab = quoteSheetName(tabName);
    const range = `${tab}!A1:CZ30`;

    const r = await axios.get(`${API_BASE}/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      params: {
        ranges: range,
        fields: "sheets(data(rowData(values(formattedValue,hyperlink,userEnteredValue(formulaValue,stringValue),textFormatRuns(startIndex,format(link(uri)))))))",
      },
      timeout: 45000,
    });
    const rows = (r.data?.sheets?.[0]?.data?.[0]?.rowData || []).map(row => row?.values || []);
    const headers = (rows[0] || []).map(c => c?.formattedValue ?? "");

    const cols = headers.map((h, i) => {
      let nCells = 0, nHyperlink = 0, nFormula = 0, nRunLink = 0;
      const samples = [];
      for(let ri = 1; ri < rows.length; ri++){
        const c = rows[ri]?.[i];
        const fv = c?.formattedValue ?? "";
        if(fv === "" && !c?.hyperlink) continue;
        nCells++;
        const formula = c?.userEnteredValue?.formulaValue || "";
        const runLink = (c?.textFormatRuns || []).map(x => x?.format?.link?.uri).find(Boolean) || "";
        if(c?.hyperlink) nHyperlink++;
        if(/^=HYPERLINK/i.test(formula)) nFormula++;
        if(runLink) nRunLink++;
        if(samples.length < 3){
          samples.push({ row: ri + 1, text: fv, hyperlink: c?.hyperlink || null, formula: formula || null, runLink: runLink || null });
        }
      }
      return { col: i, header: h, nCells, nHyperlink, nFormula, nRunLink, samples };
    }).filter(c => c.header !== "" || c.nCells > 0);

    json(res, 200, { ok: true, tab: tabName, headers, cols });
  }catch(e){
    errorResponse(res, e);
  }
}
