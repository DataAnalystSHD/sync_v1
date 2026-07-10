// Read the header/field names of a pair's SOURCE side, so the UI can offer a
// column picker. The source side depends on direction; there are three source
// kinds (Lark Base fields / Google Sheet row 1 / Lark Sheet row 1).
import { larkListFields } from "../_lib/lark/fields.js";
import { parseLarkBase, parseGoogleSheetUrl } from "../_lib/urls.js";
import { sheetsGetValues, getSheetNameByGid, quoteSheetName } from "../_lib/google/sheets.js";
import { getSheetValues, cellTextValue } from "../_lib/lark/sheets.js";
import { resolveLarkSheetTarget } from "./sync/lark-sheet-target.js";

// direction → which input holds the source, and what kind it is.
const SOURCE = {
  "lark-to-sheet":            { url: "larkUrl",  kind: "larkBase"  },
  "sheet-to-lark":            { url: "sheetUrl", kind: "google"    },
  "larksheet-to-larkbase":    { url: "sheetUrl", kind: "larkSheet" },
  "larkbase-to-larksheet":    { url: "larkUrl",  kind: "larkBase"  },
  "larksheet-to-googlesheet": { url: "sheetUrl", kind: "larkSheet" },
  "googlesheet-to-larksheet": { url: "sheetUrl", kind: "google"    },
};

async function larkBaseHeaders(url){
  const { baseId, tableId } = parseLarkBase(url);
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");
  const fields = await larkListFields({ baseId, tableId });
  return fields.map(f => f.field_name).filter(Boolean);
}

// Single/Multi-Select fields + their option values — used to build the value
// (row) filter UI. Only Lark Base sources expose this metadata; other source
// kinds return [] (Phase 1).
async function larkBaseFilterFields(url){
  const { baseId, tableId } = parseLarkBase(url);
  if(!baseId || !tableId) return [];
  const fields = await larkListFields({ baseId, tableId });
  return fields
    .filter(f => f.field_name && (f.type === 3 || f.type === 4) && Array.isArray(f.property?.options) && f.property.options.length)
    .map(f => ({
      name: f.field_name,
      multi: f.type === 4,
      options: f.property.options.map(o => o.name).filter(Boolean),
    }));
}

async function googleHeaders({ accessToken, url }){
  const { id, gid } = parseGoogleSheetUrl(url);
  if(!id) throw new Error("Invalid Google Sheet URL");
  const tabName = await getSheetNameByGid({ accessToken, spreadsheetId: id, gid });
  const tab = `${quoteSheetName(tabName)}!`;
  const headerRow = await sheetsGetValues({ accessToken, spreadsheetId: id, range: `${tab}A1:1` });
  const raw = (headerRow?.[0] || []).map(v => (v == null ? "" : String(v)));
  return takeUntilBlank(raw);
}

async function larkSheetHeaders(url){
  const { ssToken, sheetId } = await resolveLarkSheetTarget(url);
  const rows = await getSheetValues({ ssToken, sheetId, range: "A1:CZ1" });
  const raw = (rows?.[0] || []).map(v => cellTextValue(v));
  return takeUntilBlank(raw);
}

// Header rows stop at the first blank cell (matches the sync services' behaviour).
function takeUntilBlank(raw){
  const out = [];
  for(const v of raw){
    const h = String(v ?? "").trim();
    if(h === "") break;
    out.push(h);
  }
  return out;
}

export async function listSourceColumns({ accessToken, direction, sheetUrl, larkUrl }){
  const spec = SOURCE[direction];
  if(!spec) throw new Error(`Unknown direction: ${direction}`);
  const url = spec.url === "larkUrl" ? larkUrl : sheetUrl;
  if(!url) throw new Error("Missing source URL");

  if(spec.kind === "larkBase")  return larkBaseHeaders(url);
  if(spec.kind === "google")    return googleHeaders({ accessToken, url });
  if(spec.kind === "larkSheet") return larkSheetHeaders(url);
  throw new Error(`Unsupported source kind: ${spec.kind}`);
}

// Dropdown/select fields available for value filtering (Lark Base only).
export async function listSourceFilterFields({ direction, sheetUrl, larkUrl }){
  const spec = SOURCE[direction];
  if(!spec || spec.kind !== "larkBase") return [];
  const url = spec.url === "larkUrl" ? larkUrl : sheetUrl;
  if(!url) return [];
  return larkBaseFilterFields(url);
}
