import { sheetsAppend } from "../_lib/google/sheets.js";

export async function logHistory({ accessToken, cfg, sheetUrl, larkUrl, direction, user, rowCount, status, error }){
  const row = [
    new Date().toISOString(),
    sheetUrl || "",
    larkUrl  || "",
    direction || "",
    user || "system",
    rowCount || 0,
    status || "Success",
    error || "",
  ];
  await sheetsAppend({
    accessToken,
    spreadsheetId: cfg.historySheetId,
    range: `${cfg.historyTab}!A:H`,
    values: row,
  });
}
