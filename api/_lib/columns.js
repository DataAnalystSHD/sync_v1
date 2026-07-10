// Column selection: let a pair sync only a chosen subset of the source columns.
// Selection is stored on the pair as a JSON array of header NAMES (order-robust).
// The golden rule everywhere: an empty/absent selection means "all columns", so
// existing pairs keep their current full-width behaviour.

// Parse the stored `columns` cell (JSON array of names) into a string[].
// Anything unparseable / non-array becomes [] = "all columns".
export function parseColumns(raw){
  if(Array.isArray(raw)) return raw.map(String);
  if(typeof raw !== "string") return [];
  const s = raw.trim();
  if(!s) return [];
  try{
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  }catch{
    return [];
  }
}

/**
 * Restrict `allHeaders` to `selected`, keeping the ORIGINAL source order.
 * Returns { headers, indices } where:
 *   headers  = the selected header names, in source order
 *   indices  = their positions in the original row (for positional projection)
 *
 * Falls back to all columns when `selected` is empty, or when none of the
 * selected names exist in the source (so a stale selection never yields an
 * empty destination).
 */
export function selectColumns(allHeaders, selected){
  const all = Array.isArray(allHeaders) ? allHeaders : [];
  const wanted = parseColumns(selected);
  if(wanted.length === 0){
    return { headers: all, indices: all.map((_, i) => i), filtered: false };
  }
  const set = new Set(wanted.map(String));
  const indices = all.map((_, i) => i).filter(i => set.has(String(all[i])));
  if(indices.length === 0){
    return { headers: all, indices: all.map((_, i) => i), filtered: false };
  }
  return { headers: indices.map(i => all[i]), indices, filtered: true };
}

// Project a positional row array down to the selected column indices.
export function projectRow(row, indices){
  const r = row || [];
  return indices.map(i => r[i]);
}
