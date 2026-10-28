/* Regression tests for the safety-check fixes. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { csvEscape, tsvEscape, toCSV } from "../public/lib/dfmea-export.js"
import { queryCacheKey } from "../api/_lib/search-core.js"

// Fix 2: query cache key must include k so a cached 5-result response can't
// come back for a request asking for 200.
test("queryCacheKey: different k values produce different keys", () => {
  const a = queryCacheKey("pressure cooker lid", 5)
  const b = queryCacheKey("pressure cooker lid", 200)
  assert.notEqual(a, b, "cache key must include k")
})
test("queryCacheKey: same text + same k produces the same key (whitespace-insensitive)", () => {
  assert.equal(queryCacheKey("Hello World", 10), queryCacheKey("  hello world  ", 10))
})

// Fix 3: patterns.json keeps 1-record patterns too (single-record recalls
// shouldn't vanish from search results).
test("patterns.json: includes single-record patterns", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/patterns.json", import.meta.url), "utf8"))
  const single = data.patterns.filter((p) => p.total === 1)
  assert.ok(single.length > 0, "expected at least one 1-record pattern (fix 3)")
  for (const p of single) {
    // Mitigation/verification is skipped for single-record patterns (no LLM text).
    assert.ok(p.mitigation == null && p.verification == null,
      `single-record pattern ${p.category}/${p.failure_mode} shouldn't have model-generated text`)
  }
})

// Fix 4: standard numbers (60335, 60601, 2-15, 2-9) must survive numbersOk.
// Observed via at least some patterns ending with a "Check against" standard sentence.
test("patterns.json: standard references survive the number-check (fix 4)", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/patterns.json", import.meta.url), "utf8"))
  const withStandard = data.patterns.filter((p) => (p.standard || "").includes("60335"))
  assert.ok(withStandard.length > 0, "expected several patterns to carry a 'Check against IEC/UL 60335…' standard hint")
})

// Fix 8: topBrands uses canonical display names (Crock-Pot, Ninja (SharkNinja), …)
test("patterns.json: topBrands uses canonical brand display names (fix 8)", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/patterns.json", import.meta.url), "utf8"))
  // These uncanonicalized strings should never appear as a topBrand name any more.
  const uncanonical = ["CONAIR CORPORATION", "CROCK POT", "Sunbeam Products, Inc. d/b/a  Jarden Consumer Solutions", "Char-Broil LLC, of Columbus, Georgia"]
  for (const p of data.patterns) {
    for (const b of p.topBrands || []) {
      assert.ok(!uncanonical.includes(b.name), `${p.category}/${p.failure_mode}: raw brand "${b.name}" leaked into topBrands`)
    }
  }
})

// Security A: CSV / TSV formula injection prevented.
// Returns the cell's VALUE (strips CSV outer quoting + double-quote decoding).
function csvCell(s) {
  if (!s.startsWith('"')) return s
  return s.slice(1, -1).replace(/""/g, '"')
}
test("csv/tsv: prefix ' when a cell starts with = + - @ tab or CR (sec A)", () => {
  for (const trig of ["=HYPERLINK(\"x\")", "+cmd|'/C calc'!A0", "-2+3", "@SUM(A1:A10)", "\thack", "\rhack"]) {
    assert.ok(csvCell(csvEscape(trig)).startsWith("'"), `csv must neutralize ${JSON.stringify(trig)} (got ${JSON.stringify(csvEscape(trig))})`)
  }
  // TSV: tabs/newlines are flattened to spaces before the trigger check (so a
  // cell starting with \t becomes " hack", which is safe without a quote).
  for (const trig of ["=HYPERLINK(\"x\")", "+cmd|'/C calc'!A0", "-2+3", "@SUM(A1:A10)", "\rhack"]) {
    assert.ok(tsvEscape(trig).startsWith("'"), `tsv must neutralize ${JSON.stringify(trig)}`)
  }
  // Benign cells unchanged
  assert.equal(csvEscape("Lid opens under pressure"), "Lid opens under pressure")
  assert.equal(tsvEscape("Lid opens under pressure"), "Lid opens under pressure")
})
test("toCSV: a row with a formula-trigger cell is neutralized end-to-end", () => {
  const out = toCSV([{ function: "=1+1", failure_mode: "x", cause: "", effect: "", severity: "", evidence: "", verification: "", sources: [] }])
  assert.ok(out.split("\r\n")[1].startsWith("'=1+1,"))
})
