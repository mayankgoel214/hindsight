/* Pure helpers for DFMEA CSV + TSV export. No DOM, no browser APIs.
   Imported by public/app.js and tested directly from Node.
*/
export function csvEscape(v) {
  const s = v == null ? "" : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
export function tsvEscape(v) {
  // TSV has no quoting standard; replace tabs and newlines so one row stays one row.
  return (v == null ? "" : String(v)).replace(/\t/g, " ").replace(/\r?\n/g, " ")
}

export const DFMEA_HEADERS = [
  "Function", "Failure mode", "Cause", "Effect / Hazard",
  "Severity hint", "Evidence", "Suggested verification", "Source(s)",
]

function rowValues(r) {
  return [
    r.function, r.failure_mode, r.cause, r.effect, r.severity, r.evidence, r.verification,
    (r.sources || []).map((s) => `${s.label}: ${s.url}`).join(" | "),
  ]
}

export function toCSV(rows) {
  const out = [DFMEA_HEADERS.map(csvEscape).join(",")]
  for (const r of rows) out.push(rowValues(r).map(csvEscape).join(","))
  return out.join("\r\n") + "\r\n"
}
export function toTSV(rows) {
  const out = [DFMEA_HEADERS.map(tsvEscape).join("\t")]
  for (const r of rows) out.push(rowValues(r).map(tsvEscape).join("\t"))
  return out.join("\n")
}
