/* Pure helpers for DFMEA CSV + TSV export. No DOM, no browser APIs.
   Imported by public/app.js and tested directly from Node.
*/
/* Prefix a leading "formula trigger" with ' so a cell like `=HYPERLINK(...)` or
   `+cmd|'/C calc'!A0` cannot be interpreted as a spreadsheet formula when the
   file is opened. OWASP recommendation, applied to BOTH CSV and TSV output. */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/
function neutralizeFormula(s) {
  return FORMULA_TRIGGERS.test(s) ? "'" + s : s
}

export function csvEscape(v) {
  const s = neutralizeFormula(v == null ? "" : String(v))
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
export function tsvEscape(v) {
  // TSV has no quoting standard; flatten tabs/newlines so one row stays one row,
  // then apply the formula-injection guard.
  const s = (v == null ? "" : String(v)).replace(/\t/g, " ").replace(/\r?\n/g, " ")
  return neutralizeFormula(s)
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
