// Manual runner for the KOL split (same logic the scheduled /api/kol-split uses).
// Splits Lark Base "KOL 2026 Copy" by Promote Method into the New/Old KOL tabs.
//
// Run:  node scripts/split-kol-to-sheet.mjs            (rebuild both tabs)
//       DRY_RUN=1 node scripts/split-kol-to-sheet.mjs   (read + classify, no writes)
//
// Reads credentials from .env (LARK_APP_ID / LARK_APP_SECRET), falling back to
// the shell environment. All split config lives in api/_services/sync/kol-split.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const { runKolSplit } = await import("../api/_services/sync/kol-split.js");

for (const k of ["LARK_APP_ID", "LARK_APP_SECRET"]) {
  if (!process.env[k]) { console.error(`Missing env: ${k} (put it in .env or export it)`); process.exit(1); }
}

const dryRun = process.env.DRY_RUN === "1";
console.log(dryRun ? "DRY_RUN — nothing will be written\n" : "LIVE WRITE\n");

runKolSplit({ dryRun, log: (m) => console.log("  " + m) })
  .then((r) => {
    console.log(`\nDone.${dryRun ? " (DRY_RUN)" : ""}  New=${r.newCount}  Old=${r.oldCount}  Skipped=${r.skipped}  Columns=${r.columns}`);
  })
  .catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
