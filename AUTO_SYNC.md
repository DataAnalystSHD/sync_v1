# Auto-sync (Cron Manager)

ระบบซิงค์อัตโนมัติแบบตั้งเวลาต่อรายการ (per-pair interval) สำหรับ SHD Sync — Sheet ↔ Lark/Feishu

---

## ภาพรวม

แต่เดิมหน้าเว็บมีแค่ปุ่ม **Sync Now** (ซิงค์ครั้งเดียวแบบ manual) ฟีเจอร์นี้เพิ่มความสามารถให้ **บันทึกคู่ซิงค์ไว้แล้วให้ระบบรันเองตามเวลา** แม้ปิดหน้าเว็บไปแล้ว

- ตั้งช่วงเวลาได้ **ต่อแต่ละคู่ซิงค์** (5/15/30 นาที · 1/2/6/12 ชม. · ทุกวัน)
- หน้า **Cron Manager** จัดการได้ครบ: เปิด/ปิด, Run now, ลบ, ดูรอบถัดไป
- รองรับครบทั้ง 6 ทิศทางการซิงค์

---

## สถาปัตยกรรม

```
GitHub Actions (ทุก 5 นาที)
        │  GET /api/sync   (แนบ Authorization: Bearer <CRON_SECRET>)
        ▼
   handleCron()
        │  1. อ่าน active pairs ทั้งหมดจาก Google Sheet (Pairs tab)
        │  2. กรองเฉพาะคู่ที่ "ถึงเวลา" (now − lastSync ≥ interval)
        │  3. ถอดรหัส refresh token ของแต่ละคู่ → รัน runOne()
        │  4. อัปเดต lastSyncAt + บันทึก History + แจ้ง Lark (เฉพาะตอนมีงานรัน)
        ▼
   Google Sheet ⇄ Lark
```

ตัว cron ยิงทุก 5 นาที แต่ **การกรองตาม interval อยู่ฝั่ง server** — คู่ที่ตั้ง "ทุก 1 ชม." จะรันจริงแค่ชั่วโมงละครั้ง (มี slack 30 วินาทีกัน jitter)

---

## โครงสร้างข้อมูล (Google Sheet — แท็บ `Pairs`)

| คอลัมน์ | ฟิลด์ | คำอธิบาย |
|---|---|---|
| A | createdAt | เวลาที่สร้าง |
| B | sheetUrl | URL ฝั่งต้นทาง (input บน) |
| C | sheetId | Google Sheet ID (ถ้ามี) |
| D | larkUrl | URL ฝั่งปลายทาง (input ล่าง) |
| E | baseId | Lark Base ID (ถ้ามี) |
| F | tableId | Lark Table ID (ถ้ามี) |
| G | direction | ทิศทางการซิงค์ |
| H | user | อีเมลผู้สร้าง |
| I | refreshEnc | refresh token ที่เข้ารหัสด้วย `SYNC_SECRET` |
| J | active | `TRUE` / `FALSE` |
| K | lastSyncAt | เวลาที่ซิงค์ล่าสุด (ISO) |
| L | notes | หมายเหตุ |
| M | cursorRow | ตำแหน่ง cursor (paging) |
| N | phase | สถานะ |
| **O** | **intervalMin** | **ช่วงเวลา (นาที) — ใหม่** |
| **P** | **rowFrom** | **Row range เริ่ม — ใหม่** |
| **Q** | **rowTo** | **Row range จบ — ใหม่** |
| **R** | **syncMode** | **`replace` / `append` — ใหม่** |

> การลบงาน = ล้างทั้งแถว (soft delete) เพื่อไม่ต้องใช้ numeric gid ของแท็บในการ `deleteDimension`

---

## API

### `POST /api/pairs`
- **ไม่มี** `sheetUrl`/`larkUrl` → คืนรายการ pair ทั้งหมด (ตัด `refreshEnc` ออก) สำหรับ Cron Manager
- **มี** `sheetUrl`+`larkUrl` → บันทึกคู่ใหม่ พร้อม `intervalMin`, `rowFrom`, `rowTo`, `syncMode`

```json
{
  "refreshToken": "...",
  "sheetUrl": "https://docs.google.com/...",
  "larkUrl": "https://...larksuite.com/base/...?table=...",
  "direction": "sheet-to-lark",
  "intervalMin": 60,
  "rowFrom": null,
  "rowTo": null,
  "syncMode": "replace"
}
```

### `PUT /api/pairs`
แก้ไขงานที่มีอยู่ (ส่ง `rowId`)
```json
{ "refreshToken": "...", "rowId": 5, "active": false }
{ "refreshToken": "...", "rowId": 5, "intervalMin": 30 }
```

### `DELETE /api/pairs`
ลบงาน (`{ "refreshToken": "...", "rowId": 5 }`)

### `GET /api/sync`
รัน cron — เฉพาะคู่ที่ถึงเวลา ต้องผ่าน auth ถ้าตั้ง `CRON_SECRET`
```
Authorization: Bearer <CRON_SECRET>
หรือ  /api/sync?key=<CRON_SECRET>
```

### `POST /api/sync` (Run now รายคู่)
```json
{ "refreshToken": "...", "runRowId": 5 }
```
รันคู่นั้นทันที **ไม่สนใจ interval** (ใช้ owner token อ่าน + ถอดรหัส token ของคู่นั้นเอง)

---

## Environment Variables

| ตัวแปร | จำเป็น | คำอธิบาย |
|---|---|---|
| `SYNC_OWNER_REFRESH_TOKEN` | ✅ | owner token ไว้อ่าน Pairs sheet ตอน cron / Run now |
| `SYNC_SECRET` | ✅ | คีย์เข้ารหัส refresh token ของแต่ละคู่ |
| `CRON_SECRET` | แนะนำ | กัน `/api/sync` ไม่ให้ถูกยิงมั่ว — ตั้งค่านี้ทั้งใน Vercel env และ GitHub Actions secret ให้ตรงกัน |
| `HISTORY_SHEET_ID` | ✅ | Google Sheet ที่เก็บ History + Pairs |
| `PAIRS_TAB` | — | ชื่อแท็บ pair (ดีฟอลต์ `Pairs`) |
| `ALLOWED_DOMAIN` | — | โดเมนอีเมลที่อนุญาต |

> ถ้า **ไม่ตั้ง** `CRON_SECRET` → `/api/sync` GET จะเปิดให้ยิงได้อิสระ (เพื่อ backward-compat) **แนะนำให้ตั้งเสมอ**

---

## การตั้ง Scheduler (กลาง — ตั้งครั้งเดียวโดย admin)

ผู้ใช้ทั่วไป **ไม่ต้องตั้งค่าอะไร** — แค่กรอกลิงก์ เลือกทิศทาง เลือกความถี่ แล้วกด Save Auto-sync
ตัว scheduler กลางจะรันบน **GitHub Actions** ยิงเข้า `/api/sync` ทุก 5 นาที (ไฟล์ `.github/workflows/auto-sync.yml`)
รันบน server ของ GitHub → ทำงานแม้ปิดเว็บ/ปิดคอม

### Setup ครั้งเดียว (admin)
1. **Vercel** → Settings → Environment Variables → เพิ่ม `CRON_SECRET` (ค่าเดายากๆ) แล้ว Redeploy
2. **GitHub repo** → Settings → Secrets and variables → Actions:
   - **New repository secret** ชื่อ `CRON_SECRET` ใส่ค่า**เดียวกับใน Vercel**
   - (ถ้าโดเมนเปลี่ยน) เพิ่ม **Variable** `SYNC_URL` = `https://<your-app>/api/sync`
3. เปิดแท็บ **Actions** ในรีโป → กด Enable workflows (ถ้าถูกปิด) → กด **Run workflow** เพื่อทดสอบ

> GitHub Actions cron อาจดีเลย์ได้ 5–15 นาทีตอน GitHub โหลดสูง — ไม่เป็นไร เพราะ server กรองตาม interval ของแต่ละ pair อยู่แล้ว
> ถ้าต้องการตรงเวลากว่านี้: ใช้ [cron-job.org](https://console.cron-job.org) ยิง `GET /api/sync` (ใส่ header `Authorization: Bearer <CRON_SECRET>`) ทุก 5 นาทีแทน หรืออัปเกรด Vercel Pro แล้วใส่ `crons` ใน `vercel.json`

---

## การใช้งานบนหน้าเว็บ

1. **Login with Google**
2. กรอก URL ต้นทาง/ปลายทาง + เลือก Direction (และ Row Range / Sync Mode ถ้าต้องการ)
3. เลือก **Auto-sync ทุก ๆ ...**
4. กด **Save Auto-sync** → งานจะโผล่ในการ์ด **Auto-sync (Cron Manager)**
5. ในการ์ดจัดการได้:
   - **Toggle** เปิด/ปิดงาน
   - **Run now** รันทันทีโดยไม่รอรอบ
   - **🗑** ลบงาน
   - ดู *last sync* และ *รอบถัดไป*

---

## หมายเหตุ

- **Replace** จะลบข้อมูลปลายทางทั้งหมดก่อนซิงค์ใหม่ — ระวังใช้กับ interval ถี่
- แนะนำ interval **≥ 5 นาที** เพื่อลด API rate limit ของ Google/Lark
- cron จะ **เงียบ** (ไม่ส่ง Lark noti) ในรอบที่ไม่มีคู่ไหนถึงเวลา
