export function parseGoogleSheetId(url){
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : "";
}

export function parseLarkBase(url){
  const u = String(url);
  const baseId  = (u.match(/\/base\/([a-zA-Z0-9]+)/)        || [])[1] || "";
  const tableId = (u.match(/[?&]table=([a-zA-Z0-9]+)/)      || [])[1] || "";
  return { baseId, tableId };
}

export function colIndexToA1(colIdx){
  let n = colIdx + 1;
  let s = "";
  while(n > 0){
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function endColumnFor(headers){
  return colIndexToA1(Math.max(headers.length, 1) - 1);
}
