/* Pure helpers test — CSV escaping, TSV safe-flattening, header stability. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { csvEscape, tsvEscape, toCSV, toTSV, DFMEA_HEADERS } from "../public/lib/dfmea-export.js"

test("csvEscape: plain values pass through", () => {
  assert.equal(csvEscape("hello"), "hello")
  assert.equal(csvEscape(""), "")
  assert.equal(csvEscape(null), "")
  assert.equal(csvEscape(undefined), "")
  assert.equal(csvEscape(42), "42")
})

test("csvEscape: quotes, commas, newlines are quoted", () => {
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""')
  assert.equal(csvEscape("a,b"), '"a,b"')
  assert.equal(csvEscape("line1\nline2"), '"line1\nline2"')
  assert.equal(csvEscape("ends with \r"), '"ends with \r"')
})

test("tsvEscape: tabs and newlines flattened to spaces", () => {
  assert.equal(tsvEscape("a\tb"), "a b")
  assert.equal(tsvEscape("a\nb"), "a b")
  assert.equal(tsvEscape("a\r\nb"), "a b")
  assert.equal(tsvEscape("a\tb\nc"), "a b c")
})

test("toCSV: header + one row, RFC 4180 line ending", () => {
  const rows = [{
    function: "Lid retains pressure",
    failure_mode: 'opens "while hot"',
    cause: "interlock defeat",
    effect: "burn, scald",
    severity: "High",
    evidence: "5 recalls, 2 alerts; 106 injured",
    verification: "Pressurize to 1.5x; attempt to open.",
    sources: [{ label: "CPSC", url: "https://cpsc.gov/x" }, { label: "HC", url: "https://hc.ca/y" }],
  }]
  const out = toCSV(rows)
  const lines = out.split("\r\n")
  assert.equal(lines.length, 3) // header, row, trailing blank
  assert.equal(lines[0], DFMEA_HEADERS.join(","))
  assert.ok(lines[1].includes('"opens ""while hot"""'))
  assert.ok(lines[1].includes('"burn, scald"'))
  assert.ok(lines[1].includes("CPSC: https://cpsc.gov/x | HC: https://hc.ca/y"))
  assert.equal(lines[2], "")
})

test("toTSV: header + rows separated by \\n, no raw tabs/newlines inside cells", () => {
  const rows = [{
    function: "f\twith tab",
    failure_mode: "fm\nwith newline",
    cause: "", effect: "", severity: "", evidence: "", verification: "",
    sources: [{ label: "src", url: "https://x" }],
  }]
  const out = toTSV(rows)
  const lines = out.split("\n")
  assert.equal(lines.length, 2)
  const cells = lines[1].split("\t")
  // 7 named columns + 1 source column
  assert.equal(cells.length, 8)
  assert.equal(cells[0], "f with tab")
  assert.equal(cells[1], "fm with newline")
})

test("toCSV: empty rows produces just a header line + trailing CRLF", () => {
  const out = toCSV([])
  assert.equal(out, DFMEA_HEADERS.join(",") + "\r\n")
})

test("toTSV: sources missing is handled", () => {
  const out = toTSV([{ function: "x", failure_mode: "y", cause: "", effect: "", severity: "", evidence: "", verification: "" }])
  const cells = out.split("\n")[1].split("\t")
  assert.equal(cells[7], "")
})
