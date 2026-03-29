import {
  json, mustEnv, getConfig,
  parseGoogleSheetId, parseLarkBase,
  decryptText, refreshAccessToken,
  sheetsGetValues, sheetsClear, sheetsUpdate, sheetsAppend,
  larkListAllRecords, larkBatchDeleteAll, larkCreateRecordsBatched,
  larkEnsureFields
} from "./_util.js";

function normalizeCell(v){
  if(v === null || v === undefined) return "";
  if(typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function guessA1EndCol(headers){
  const n = Math.max(headers.length, 1);
  let col = "";
  let x = n;
  while(x>0){
    const r = (x-1)%26;
    col = String.fromCharCode(65+r) + col;
    x = Math.floor((x-1)/26);
  }
  return col;
}

async function logHistory({ accessToken, cfg, sheetUrl, larkUrl, direction, user, rowCount, status, error }){
  const row = [
    new Date().toISOString(),
    sheetUrl || "",
    larkUrl || "",
    direction || "",
    user || "system",
    rowCount || 0,
    status || "Success",
    error || ""
  ];
  await sheetsAppend({ accessToken, spreadsheetId: cfg.historySheetId, range: `${cfg.historyTab}!A:H`, values: row });
}

async function readPairsFromHistory({ refreshToken }){
  const cfg = getConfig();
  const accessToken = await refreshAccessToken(refreshToken);

  // ✅ อ่านถึงคอลัมน์ N เพื่อเก็บ cursor/phase (M,N)
  const rows = await sheetsGetValues({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.pairsTab}!A1:N20000`
  });

  if(rows.length <= 1) return [];
  const data = rows.slice(1);

  return data.map((r, i) => ({
    rowId: i + 2,
    createdAt: r[0] || "",
    sheetUrl: r[1] || "",
    sheetId: r[2] || "",
    larkUrl: r[3] || "",
    baseId: r[4] || "",
    tableId: r[5] || "",
    direction: r[6] || "lark-to-sheet",
    user: r[7] || "",
    refreshEnc: r[8] || "",
    active: (String(r[9]||"TRUE").toUpperCase() !== "FALSE"),
    lastSyncAt: r[10] || "",
    notes: r[11] || "",

    // ✅ ใหม่: cursor/phase (ถ้าไม่มีให้ default)
    cursorRow: parseInt(r[12] || "2", 10),   // M
    phase: r[13] || "idle"                  // N
  })).filter(x => x.active && x.sheetId && x.baseId && x.tableId && x.refreshEnc);
}

async function updateLastSync({ accessToken, cfg, rowId }){
  const range = `${cfg.pairsTab}!K${rowId}:K${rowId}`; // LastSyncAt column K
  await sheetsUpdate({ accessToken, spreadsheetId: cfg.historySheetId, range, values: [[new Date().toISOString()]] });
}

// ✅ ใหม่: อัปเดต cursor/phase (Pairs tab คอลัมน์ M/N)
async function updateCursor({ accessToken, cfg, rowId, cursorRow }){
  const range = `${cfg.pairsTab}!M${rowId}:M${rowId}`; // cursor_row
  await sheetsUpdate({ accessToken, spreadsheetId: cfg.historySheetId, range, values: [[String(cursorRow)]] });
}

async function updatePhase({ accessToken, cfg, rowId, phase }){
  const range = `${cfg.pairsTab}!N${rowId}:N${rowId}`; // phase
  await sheetsUpdate({ accessToken, spreadsheetId: cfg.historySheetId, range, values: [[phase]] });
}

async function syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId }){
  const items = await larkListAllRecords({ baseId, tableId });
  const max = cfg.maxRowsPerSync;
  const limited = items.slice(0, max);

  // Auto-detect headers from Lark record fields
  const headerSet = new Set();
  for(const it of limited){
    const fields = it.fields || {};
    for(const key of Object.keys(fields)) headerSet.add(key);
  }
  const headers = Array.from(headerSet);

  if(headers.length === 0){
    return { rowCount: 0, truncated: items.length > limited.length };
  }

  const endCol = guessA1EndCol(headers);

  // Clear entire sheet (headers + data) then rewrite everything
  await sheetsClear({ accessToken, spreadsheetId: sheetId, range: `A1:${endCol}` });

  // Write headers to row 1
  await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range: `A1:${endCol}1`, values: [headers] });

  // Write data from row 2
  const rows = limited.map(it => {
    const fields = it.fields || {};
    return headers.map(h => normalizeCell(fields[h]));
  });

  const chunkSize = parseInt(process.env.SHEET_WRITE_CHUNK || "2000", 10);
  for(let i=0;i<rows.length;i+=chunkSize){
    const chunk = rows.slice(i, i+chunkSize);
    const startRow = 2 + i;
    const range = `A${startRow}:${endCol}${startRow + chunk.length - 1}`;
    await sheetsUpdate({ accessToken, spreadsheetId: sheetId, range, values: chunk });
  }

  return { rowCount: rows.length, truncated: items.length > rows.length };
}

/**
 * ✅ Sheet -> Lark แบบ 100K+:
 * - ทำทีละหน้า (PAGE_SIZE) ต่อการเรียก 1 ครั้ง
 * - เก็บ cursor/phase ใน Pairs tab (M/N) เพื่อทำต่อใน cron รอบหน้า
 *
 * สำคัญ:
 * - รอบเริ่มงานใหม่จะ "ลบทั้งตาราง" 1 ครั้งเท่านั้น
 * - รอบถัด ๆ ไป จะ create ต่อท้ายเรื่อย ๆ
 */
async function syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId, pair }){
  const header = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range: `A1:1` });
  const headers = header?.[0] || [];
  if(headers.length === 0) throw new Error("Sheet has no header row (row 1 must contain headers)");

  const endCol = guessA1EndCol(headers);

  // ✅ กำหนดจำนวนแถวต่อรอบ (แนะนำ 20000)
  const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || "20000", 10);

  // cursorRow เริ่มแถว 2
  let cursorRow = Number(pair?.cursorRow || 2);
  const rowId = pair?.rowId; // มีเฉพาะกรณี Save Pair แล้ว (cron mode)
  const phase = pair?.phase || "idle";

  // forceNew = true → บังคับ full-replace ทุกครั้ง (ใช้กับ manual/auto sync)
  const forceNew = pair?.forceNew === true;

  // เริ่มงานใหม่เมื่อ:
  // - forceNew (manual/auto) 
  // - ยังไม่ running
  // - หรือ cursorRow <= 2
  const startingNew = forceNew || (phase !== "sheet2lark_running") || cursorRow <= 2;

  if(startingNew){
    // ถ้ามี rowId ให้บันทึกสถานะใน Pairs tab เพื่อ resume ได้
    if(rowId){
      await updatePhase({ accessToken, cfg, rowId, phase: "sheet2lark_running" });
      await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
    }

    cursorRow = 2;

    // Auto-create missing fields in Lark from Sheet headers
    await larkEnsureFields({ baseId, tableId, fieldNames: headers });

    // ✅ ลบครั้งเดียวตอนเริ่มงานเท่านั้น
    await larkBatchDeleteAll({ baseId, tableId });
  }

  const start = cursorRow;
  const end = cursorRow + PAGE_SIZE - 1;
  const range = `A${start}:${endCol}${end}`;

  const values = await sheetsGetValues({ accessToken, spreadsheetId: sheetId, range });

  // ไม่มีข้อมูลแล้ว = จบงาน
  if(!values || values.length === 0){
    if(rowId){
      await updatePhase({ accessToken, cfg, rowId, phase: "idle" });
      await updateCursor({ accessToken, cfg, rowId, cursorRow: 2 });
    }
    return { rowCount: 0, truncated: false, done: true };
  }

  // map rows -> records(fields)
  const records = values.map(row => {
    const obj = {};
    headers.forEach((h, idx) => obj[h] = row[idx] ?? "");
    return obj;
  });

  // ✅ Batch create (500/req) จะเร็วมาก
  await larkCreateRecordsBatched({ baseId, tableId, records });

  const nextCursor = cursorRow + records.length;

  // update checkpoint
  if(rowId){
    await updateCursor({ accessToken, cfg, rowId, cursorRow: nextCursor });
  }

  return {
    rowCount: records.length,
    truncated: false,
    done: false,
    page: { startRow: cursorRow, endRow: nextCursor - 1, pageSize: PAGE_SIZE },
    nextCursorRow: nextCursor
  };
}

export default async function handler(req, res){
  const cfg = getConfig();
  try{
    if(req.method === "GET"){
      const ownerRefresh = process.env.SYNC_OWNER_REFRESH_TOKEN;
      if(!ownerRefresh){
        json(res, 400, { ok:false, error:"Missing SYNC_OWNER_REFRESH_TOKEN env. Cron mode needs an owner refresh token to read pairs." });
        return;
      }

      const pairs = await readPairsFromHistory({ refreshToken: ownerRefresh });
      const secret = mustEnv("SYNC_SECRET");

      const results = [];
      for(const p of pairs){
        const pairRefresh = decryptText(p.refreshEnc, secret);
        const accessToken = await refreshAccessToken(pairRefresh);
        try{
          const r = await runOne({
            accessToken,
            cfg,
            pair: { ...p, refreshToken: pairRefresh, userEmail: p.user || "cron" }
          });

          results.push({ pair: p.sheetUrl, status:"success", ...r });

          // last sync time
          await updateLastSync({ accessToken, cfg, rowId: p.rowId });

          await logHistory({
            accessToken,
            cfg,
            sheetUrl:p.sheetUrl,
            larkUrl:p.larkUrl,
            direction:p.direction,
            user:p.user||"cron",
            rowCount:r.rowCount,
            status:"Success",
            error:""
          });
        }catch(e){
          results.push({ pair: p.sheetUrl, status:"error", error: e.message });
          await logHistory({
            accessToken,
            cfg,
            sheetUrl:p.sheetUrl,
            larkUrl:p.larkUrl,
            direction:p.direction,
            user:p.user||"cron",
            rowCount:0,
            status:"Error",
            error:e.message
          });
        }
      }

      json(res, 200, { ok:true, mode:"cron", processed: results.length, results });
      return;
    }

    if(req.method === "POST"){
      const body = req.body || {};
      const pairs = body.pairs || [];
      if(!Array.isArray(pairs) || pairs.length === 0) throw new Error("Missing pairs[]");

      const results = [];
      for(const input of pairs){
        const refreshToken = input.refreshToken || "";
        if(!refreshToken) throw new Error("Missing refreshToken in pair");
        const accessToken = await refreshAccessToken(refreshToken);

        try{
          // ✅ manual/auto mode: forceNew=true → full-replace ทุกครั้ง (ไม่ resume cursor)
          const r = await runOne({ accessToken, cfg, pair: { ...input, forceNew: input.forceNew !== false } });

          results.push({
            status:"success",
            rowCount: r.rowCount,
            truncated: r.truncated || false,
            done: r.done || false,
            page: r.page || null,
            nextCursorRow: r.nextCursorRow || null
          });

          await logHistory({
            accessToken,
            cfg,
            sheetUrl: input.sheetUrl,
            larkUrl: input.larkUrl,
            direction: input.direction,
            user: input.userEmail || input.user || "manual",
            rowCount: r.rowCount,
            status: "Success",
            error: ""
          });

          // ถ้ามี rowId (มาจาก Save Pair) ให้ update ได้
          if(input.rowId) {
            await updateLastSync({ accessToken, cfg, rowId: parseInt(input.rowId,10) });
          }
        }catch(e){
          results.push({ status:"error", error: e.message });
          await logHistory({
            accessToken,
            cfg,
            sheetUrl: input.sheetUrl,
            larkUrl: input.larkUrl,
            direction: input.direction,
            user: input.userEmail || input.user || "manual",
            rowCount: 0,
            status: "Error",
            error: e.message
          });
        }
      }

      json(res, 200, { ok:true, processed: results.length, results });
      return;
    }

    json(res, 405, { ok:false, error:"Method not allowed" });
  }catch(e){
    json(res, 500, { ok:false, error: e.message });
  }
}

async function runOne({ accessToken, cfg, pair }){
  const sheetUrl = pair.sheetUrl;
  const larkUrl = pair.larkUrl;
  const direction = pair.direction === "sheet-to-lark" ? "sheet-to-lark" : "lark-to-sheet";

  const sheetId = pair.sheetId || parseGoogleSheetId(sheetUrl);
  if(!sheetId) throw new Error("Invalid Google Sheet URL");

  const parsed = parseLarkBase(larkUrl);
  const baseId = pair.baseId || parsed.baseId;
  const tableId = pair.tableId || parsed.tableId;
  if(!baseId || !tableId) throw new Error("Invalid Lark Base URL (need /base/<baseId>?table=<tableId>)");

  if(direction === "lark-to-sheet"){
    return await syncLarkToSheet({ accessToken, cfg, sheetId, baseId, tableId });
  }else{
    // ✅ ส่ง pair เข้าไป เพื่อใช้ cursorRow/phase/rowId
    return await syncSheetToLark({ accessToken, cfg, sheetId, baseId, tableId, pair });
  }
}

