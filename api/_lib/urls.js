export function parseGoogleSheetUrl(url){
  const u = String(url);
  const id  = (u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || "";
  const gid = (u.match(/[?#&]gid=(\d+)/)                       || [])[1] || "";
  return { id, gid };
}

export function parseGoogleSheetId(url){
  return parseGoogleSheetUrl(url).id;
}

export function parseLarkBase(url){
  const u = String(url);
  const baseId  = (u.match(/\/base\/([a-zA-Z0-9]+)/)        || [])[1] || "";
  const tableId = (u.match(/[?&]table=([a-zA-Z0-9]+)/)      || [])[1] || "";
  return { baseId, tableId };
}

export function parseLarkSheetUrl(url){
  const u = String(url);
  const wiki  = (u.match(/\/wiki\/([a-zA-Z0-9]+)/)            || [])[1] || "";
  const sheet = (u.match(/\/sheets\/([a-zA-Z0-9]+)/)          || [])[1] || "";
  const sheetId = (u.match(/[?&]sheet(?:_id)?=([a-zA-Z0-9]+)/) || [])[1] || "";
  if(wiki)  return { kind: "wiki",  token: wiki,  sheetId };
  if(sheet) return { kind: "sheet", token: sheet, sheetId };
  return { kind: "", token: "", sheetId: "" };
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
