export function mustEnv(name){
  const v = process.env[name];
  if(!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getConfig(){
  return {
    allowedDomain: process.env.ALLOWED_DOMAIN || "shd-technology.co.th",
    historySheetId: process.env.HISTORY_SHEET_ID || "",
    historyTab: process.env.HISTORY_TAB || "History",
    pairsTab: process.env.PAIRS_TAB || "Pairs",
    maxRowsPerSync: parseInt(process.env.MAX_ROWS_PER_SYNC || "5000", 10),
    pageSize: parseInt(process.env.PAGE_SIZE || "20000", 10),
    sheetWriteChunk: parseInt(process.env.SHEET_WRITE_CHUNK || "2000", 10),
    larkRetries: parseInt(process.env.LARK_RETRIES || "6", 10),
    larkApiBase: process.env.LARK_OPEN_API_BASE || "https://open.feishu.cn",
  };
}
