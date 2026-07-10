// Read-only status of the KOL split: Base classification vs current sheet tabs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, "utf8").split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim(); }

const { larkListAllRecords } = await import("../api/_lib/lark/records.js");
const { larkListFields } = await import("../api/_lib/lark/fields.js");
const { formatBitableValue, buildFieldTypeMap } = await import("../api/_lib/lark/field-types.js");
const { getSheetMeta, getSheetValues, cellTextValue } = await import("../api/_lib/lark/sheets.js");
const { resolveWikiNode } = await import("../api/_lib/lark/wiki.js");
const { endColumnFor } = await import("../api/_lib/urls.js");

const baseId = "F8pGb3xbhahlQvsnGwZcRVfanzh", tableId = "tblYcRghvSyxx8ik", viewId = "vewf7lG6fU";
const items = await larkListAllRecords({ baseId, tableId, viewId });
const fields = await larkListFields({ baseId, tableId });
const headers = fields.map((f) => f.field_name).filter(Boolean);
const tm = buildFieldTypeMap(fields);
const pk = headers.find((h) => /promote/i.test(h));

const nw = [], od = []; let sk = 0;
for (const it of items) {
  const f = it.fields || {};
  const pm = String(formatBitableValue(f[pk], tm.get(pk))).trim().toLowerCase();
  const row = headers.map((h) => formatBitableValue(f[h], tm.get(h)));
  if (pm === "new kol") nw.push(row); else if (pm === "old kol") od.push(row); else sk++;
}
console.log(`Base: ${items.length} records  |  New KOL=${nw.length}  Old KOL=${od.length}  Skipped=${sk}`);

const { objToken: ss } = await resolveWikiNode("B0thw6Lo9i8PMnkPlgoci3lOnre");
const endCol = endColumnFor(headers);

async function status(name, id, rows) {
  const meta = await getSheetMeta({ ssToken: ss, sheetId: id });
  const rc = Number(meta?.grid_properties?.row_count || 0);
  const colA = await getSheetValues({ ssToken: ss, sheetId: id, range: `A1:A${rc}` });
  let last = 0; for (let i = colA.length - 1; i >= 0; i--) { if (String(colA[i]?.[0] ?? "").trim() !== "") { last = i + 1; break; } }
  let match = last === rows.length + 1;
  if (match && rows.length) {
    const g = await getSheetValues({ ssToken: ss, sheetId: id, range: `A2:${endCol}${1 + rows.length}` });
    outer: for (let i = 0; i < rows.length; i++) for (let j = 0; j < headers.length; j++) {
      if (String(rows[i][j] ?? "") !== cellTextValue((g[i] || [])[j])) { match = false; break outer; }
    }
  }
  console.log(`${name}: sheet rows=${Math.max(last - 1, 0)}  expected=${rows.length}  in-sync=${match ? "YES ✓" : "NO — out of date"}`);
}
await status("New KOL tab", "ZvXhDy", nw);
await status("Old KOL tab", "s8GBQA", od);
