// Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). No deps.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvToObjects(text, { headerRow = 0 } = {}) {
  const rows = parseCsv(text);
  const header = rows[headerRow].map((h) => h.trim());
  return rows.slice(headerRow + 1).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])));
}
