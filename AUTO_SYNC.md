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
Vercel Cron (ทุก 5 นาที)
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
| `CRON_SECRET` | แนะนำ | กัน `/api/sync` ไม่ให้ถูกยิงมั่ว (Vercel Cron แนบ header ให้อัตโนมัติ) |
| `HISTORY_SHEET_ID` | ✅ | Google Sheet ที่เก็บ History + Pairs |
| `PAIRS_TAB` | — | ชื่อแท็บ pair (ดีฟอลต์ `Pairs`) |
| `ALLOWED_DOMAIN` | — | โดเมนอีเมลที่อนุญาต |

> ถ้า **ไม่ตั้ง** `CRON_SECRET` → `/api/sync` GET จะเปิดให้ยิงได้อิสระ (เพื่อ backward-compat) **แนะนำให้ตั้งเสมอ**

---

## การตั้ง Scheduler

### ตัวเลือก A — External Cron (แนะนำ · ใช้ได้ทุกแผน · ฟรี)
ใช้บริการอย่าง [cron-job.org](https://cron-job.org) ตั้งให้ยิงทุก 5 นาที:
```
GET https://sync-v1.vercel.app/api/sync?key=<CRON_SECRET>
```
เป็น server-side รันแม้ปิดหน้าเว็บ และไม่ติดข้อจำกัดแผน Vercel

### ตัวเลือก B — Vercel Cron (ต้องใช้แผน **Pro**)
> ⚠️ แผน **Hobby** รัน Vercel Cron ได้แค่ **วันละครั้ง** — ถ้าใส่ schedule ถี่กว่านั้น
> (เช่น `*/5 * * * *`) **deploy จะ fail** ด้วยเหตุนี้เอง `vercel.json` จึงไม่ได้ใส่ cron ไว้

ถ้าอัปเกรดเป็น Pro แล้ว เพิ่ม block นี้ใน `vercel.json` ได้:
```json
{
  "version": 2,
  "crons": [{ "path": "/api/sync", "schedule": "*/5 * * * *" }]
}
```
ตั้ง `CRON_SECRET` ใน Vercel → ระบบจะแนบ `Authorization: Bearer` ให้เอง

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
