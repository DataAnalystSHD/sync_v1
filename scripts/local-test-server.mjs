// Lightweight LOCAL test server for the column-picker feature.
//
// Why this exists: full `vercel dev` needs Google OAuth (redirect is prod-only)
// and cloud env we can't pull. But scanning Lark Base / Lark Sheet columns only
// needs the Lark tenant creds already in .env — so this server serves the real
// UI, does REAL column scans against Lark, and SIMULATES sync (never writes) so
// you can click through the whole flow safely on localhost.
//
//   node scripts/local-test-server.mjs        → http://localhost:3000
//
// Google-source scans (Google Sheet → ...) aren't available here (need OAuth);
// use a Lark Base or Lark Sheet as the source to test.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// load .env
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

const { listSourceColumns, listSourceFilterFields } = await import("../api/_services/list-columns.js");
const { selectColumns } = await import("../api/_lib/columns.js");
const { larkListAllRecords } = await import("../api/_lib/lark/records.js");
const { parseLarkBase, parseGoogleSheetId, parseLarkSheetUrl } = await import("../api/_lib/urls.js");

// Mirror production validation so a mismatched direction/URL can't be saved.
const FIELD_KINDS = {
  "lark-to-sheet": { top: "google", bottom: "larkBase" },
  "sheet-to-lark": { top: "google", bottom: "larkBase" },
  "larksheet-to-larkbase": { top: "larkSheet", bottom: "larkBase" },
  "larkbase-to-larksheet": { top: "larkSheet", bottom: "larkBase" },
  "larksheet-to-googlesheet": { top: "larkSheet", bottom: "google" },
  "googlesheet-to-larksheet": { top: "google", bottom: "larkSheet" },
};
function validateSide(kind, url) {
  if (kind === "google" && !parseGoogleSheetId(url)) return "ต้องเป็นลิงก์ Google Sheet (docs.google.com/spreadsheets/...)";
  if (kind === "larkSheet" && !parseLarkSheetUrl(url).token) return "ต้องเป็นลิงก์ Lark Sheet (/wiki/... หรือ /sheets/...)";
  if (kind === "larkBase") { const { baseId, tableId } = parseLarkBase(url); if (!baseId || !tableId) return "ต้องเป็นลิงก์ Lark Base (/base/<id>?table=<id>)"; }
  return null;
}
function validatePair(direction, sheetUrl, larkUrl) {
  const k = FIELD_KINDS[direction];
  if (!k) return "ทิศทางไม่ถูกต้อง";
  const e1 = validateSide(k.top, sheetUrl); if (e1) return "ช่องบน — " + e1;
  const e2 = validateSide(k.bottom, larkUrl); if (e2) return "ช่องล่าง — " + e2;
  return null;
}
const { runOne } = await import("../api/_services/sync/runner.js");
const { getConfig } = await import("../api/_lib/config.js");

// Directions that touch ONLY Lark (tenant token in .env) — safe to run for real
// on localhost. Google-involving directions stay simulated (need OAuth we lack).
const LARK_ONLY = new Set(["larkbase-to-larksheet", "larksheet-to-larkbase"]);

// In-memory Auto-sync store so save → appears works locally (resets on restart).
let localPairs = [];
let pairSeq = 1;

// In-memory history sample so delete/clear can be tested locally.
let localHistory = [
  { row: 1, time: "2026-07-10T11:20:00.000Z", sheetUrl: "https://j1zplfh5yg.feishu.cn/wiki/Xktdw7CNYiuEnVk2VdGcuo6Bn2d", larkUrl: "https://j1zplfh5yg.feishu.cn/base/JGnFb0rMbaLyJssz1A7co9GQnKf?table=tblkt1z4KjBuhvMl", direction: "larkbase-to-larksheet", user: "the.dataverse@shd-technology.co.th", rowCount: 1639, status: "Success", error: "" },
  { row: 2, time: "2026-07-10T11:05:00.000Z", sheetUrl: "https://j1zplfh5yg.feishu.cn/base/F8pGb3xbhahlQvsnGwZcRVfanzh?table=tblYcRghvSyxx8ik", larkUrl: "https://j1zplfh5yg.feishu.cn/wiki/B0thw6Lo9i8PMnkPlgoci3lOnre", direction: "larkbase-to-larksheet", user: "nun.rungwikrai@shd-technology.co.th", rowCount: 476, status: "Success", error: "" },
  { row: 3, time: "2026-07-10T10:40:00.000Z", sheetUrl: "https://docs.google.com/spreadsheets/d/1Acpk4aGp5JCAWztvkYN2Ooe5GwdXj5yeAs4Ozv_PARc", larkUrl: "https://j1zplfh5yg.feishu.cn/base/JGnFb0rMbaLyJssz1A7co9GQnKf?table=tblkt1z4KjBuhvMl", direction: "lark-to-sheet", user: "the.dataverse@shd-technology.co.th", rowCount: 0, status: "Error", error: "HTTP 403 code=91403 msg=Forbidden (app not added to file)" },
];
const normInterval = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 10080) : 60; };

const PUBLIC = path.join(ROOT, "public");
const PORT = 3000;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// Source side per direction (mirrors api/_services/list-columns.js)
const SOURCE = {
  "lark-to-sheet": { url: "larkUrl", kind: "larkBase" },
  "sheet-to-lark": { url: "sheetUrl", kind: "google" },
  "larksheet-to-larkbase": { url: "sheetUrl", kind: "larkSheet" },
  "larkbase-to-larksheet": { url: "larkUrl", kind: "larkBase" },
  "larksheet-to-googlesheet": { url: "sheetUrl", kind: "larkSheet" },
  "googlesheet-to-larksheet": { url: "sheetUrl", kind: "google" },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    // ── API ──
    if (p === "/api/config") {
      return sendJson(res, 200, {
        historySheetId: "LOCAL-TEST (simulated)",
        allowedDomain: process.env.ALLOWED_DOMAIN || "shd-technology.co.th",
        adminEmails: ["local-test"],   // the auto-enabled local user → admin, all tabs visible
        localTest: true,               // tells app.js to skip login entirely
      });
    }

    if (p === "/api/columns" && req.method === "POST") {
      const body = await readBody(req);
      const spec = SOURCE[body.direction];
      if (spec && spec.kind === "google") {
        return sendJson(res, 200, { ok: false, error: "โหมด local: สแกน Google Sheet ไม่ได้ (ต้อง login) — ลองใช้ Lark Base/Sheet เป็นต้นทาง" });
      }
      // Lark sources need no Google token.
      const headers = await listSourceColumns({ accessToken: null, direction: body.direction, sheetUrl: body.sheetUrl || "", larkUrl: body.larkUrl || "" });
      let filterFields = [];
      try { filterFields = await listSourceFilterFields({ direction: body.direction, sheetUrl: body.sheetUrl || "", larkUrl: body.larkUrl || "" }); } catch {}
      return sendJson(res, 200, { ok: true, headers, filterFields });
    }

    if (p === "/api/pairs") {
      const body = await readBody(req);
      if (req.method === "POST" && (!body.sheetUrl || !body.larkUrl)) {
        return sendJson(res, 200, { ok: true, pairs: localPairs });   // list
      }
      if (req.method === "POST") {
        const verr = validatePair(body.direction || "lark-to-sheet", body.sheetUrl, body.larkUrl);
        if (verr) return sendJson(res, 200, { ok: false, error: verr });
        const pair = {
          rowId: ++pairSeq,
          createdAt: new Date().toISOString(),
          sheetUrl: body.sheetUrl, larkUrl: body.larkUrl,
          direction: body.direction || "lark-to-sheet",
          user: "local-test",
          active: true, lastSyncAt: "",
          intervalMin: normInterval(body.intervalMin),
          rowFrom: null, rowTo: null,
          syncMode: body.syncMode === "append" ? "append" : "replace",
          columns: body.columns || [], filters: body.filters || [],
        };
        localPairs.push(pair);
        return sendJson(res, 200, { ok: true, saved: true, simulated: true });
      }
      if (req.method === "PUT") {
        if (body.sheetUrl && body.larkUrl) {
          const verr = validatePair(body.direction || "lark-to-sheet", body.sheetUrl, body.larkUrl);
          if (verr) return sendJson(res, 200, { ok: false, error: verr });
        }
        const pr = localPairs.find(x => x.rowId === parseInt(body.rowId, 10));
        if (pr) {
          if (body.active != null) pr.active = body.active !== false;
          if (body.intervalMin != null) pr.intervalMin = normInterval(body.intervalMin);
          if (body.syncMode != null) pr.syncMode = body.syncMode === "append" ? "append" : "replace";
          if (body.sheetUrl != null) pr.sheetUrl = body.sheetUrl;
          if (body.larkUrl != null) pr.larkUrl = body.larkUrl;
          if (body.direction != null) pr.direction = body.direction;
          if (body.columns != null) pr.columns = body.columns;
          if (body.filters != null) pr.filters = body.filters;
        }
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        localPairs = localPairs.filter(x => x.rowId !== parseInt(body.rowId, 10));
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { ok: true, simulated: true });
    }

    if (p === "/api/sync" && req.method === "POST") {
      const body = await readBody(req);
      let input, runPair = null;
      if (body.runRowId) {
        runPair = localPairs.find(x => x.rowId === parseInt(body.runRowId, 10));
        if (!runPair) return sendJson(res, 200, { ok: true, results: [{ status: "error", error: "pair not found (local)" }] });
        input = runPair;
      } else {
        input = (body.pairs || [])[0] || {};
      }
      const cols = input.columns || [];
      const markRun = () => { if (runPair) runPair.lastSyncAt = new Date().toISOString(); };

      // Lark→Lark: run for REAL (writes to the destination Lark Sheet/Base).
      if (LARK_ONLY.has(input.direction)) {
        try {
          const r = await runOne({ accessToken: null, cfg: getConfig(), pair: { ...input, forceNew: true } });
          markRun();
          console.log(`[REAL sync] ${input.direction} → ${r?.rowCount} rows, cols=${cols.length || "all"}`);
          return sendJson(res, 200, { ok: true, results: [{ status: "success", rowCount: r?.rowCount || 0, note: `REAL write ✓ · ${cols.length ? cols.length + " คอลัมน์" : "ทุกคอลัมน์"}` }] });
        } catch (e) {
          console.log(`[REAL sync ERR] ${e.message}`);
          return sendJson(res, 200, { ok: true, results: [{ status: "error", error: e.message }] });
        }
      }

      // Google-involving directions: simulate (no OAuth locally).
      let rowCount = 0, headerInfo = "";
      try {
        const spec = SOURCE[input.direction];
        if (spec && spec.kind === "larkBase") {
          const { baseId, tableId, viewId } = parseLarkBase(input.larkUrl || "");
          const items = await larkListAllRecords({ baseId, tableId, viewId });
          rowCount = items.length;
        }
        const full = await listSourceColumns({ accessToken: null, direction: input.direction, sheetUrl: input.sheetUrl, larkUrl: input.larkUrl });
        const { headers } = selectColumns(full, cols);
        headerInfo = `${headers.length}/${full.length} คอลัมน์: ${headers.join(", ")}`;
      } catch (e) { headerInfo = "อ่านต้นทางไม่ได้: " + e.message; }
      markRun();
      return sendJson(res, 200, {
        ok: true, simulated: true,
        results: [{ status: "success", rowCount, note: "SIMULATED (Google ต้อง login) · " + headerInfo }],
      });
    }

    if (p === "/api/history") {
      if (req.method === "DELETE") {
        if (url.searchParams.get("all")) { localHistory = []; return sendJson(res, 200, { ok: true, cleared: "all" }); }
        const row = parseInt(url.searchParams.get("row"), 10);
        localHistory = localHistory.filter(h => h.row !== row);
        return sendJson(res, 200, { ok: true, cleared: row });
      }
      // Local has no real History sheet — return the in-memory sample.
      return sendJson(res, 200, { ok: true, simulated: true, items: localHistory });
    }

    if (p.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "not found (local stub)" });

    // ── static ──
    let file = p === "/" ? "/index.html" : p;
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "text/plain" });
    return res.end(fs.readFileSync(full));
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e?.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Local test server → http://localhost:${PORT}`);
  console.log(`  • Login: ไม่ต้อง (ตั้ง localStorage fake token ให้ปุ่มเปิดใช้)`);
  console.log(`  • สแกนได้เฉพาะต้นทาง Lark Base / Lark Sheet · Sync = จำลอง ไม่เขียนจริง\n`);
});
