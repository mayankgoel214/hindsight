/* Patterns.json shouldn't ship two numbers that disagree about the same thing.
   This locks the fix in scripts/patterns.mjs: counts.recall / alert / incident
   are the atoms; verifiedActions = recall + alert; unverifiedReports = incident.
*/
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const data = JSON.parse(await readFile(new URL("../public/data/patterns.json", import.meta.url), "utf8"))

test("patterns.json: has the renamed, unambiguous fields", () => {
  assert.ok(Array.isArray(data.patterns) && data.patterns.length > 0)
  for (const p of data.patterns) {
    assert.ok(typeof p.verifiedActions === "number", `${p.category}/${p.failure_mode}: missing verifiedActions`)
    assert.ok(typeof p.unverifiedReports === "number", `${p.category}/${p.failure_mode}: missing unverifiedReports`)
    // The old ambiguous `recalls` field is gone so the UI can't disagree with counts.
    assert.equal(p.recalls, undefined, `${p.category}/${p.failure_mode}: stale 'recalls' field still present`)
    assert.equal(p.incidents, undefined, `${p.category}/${p.failure_mode}: stale 'incidents' field still present`)
  }
})

test("patterns.json: verifiedActions == counts.recall + counts.alert for every pattern", () => {
  for (const p of data.patterns) {
    const expected = (p.counts.recall || 0) + (p.counts.alert || 0)
    assert.equal(p.verifiedActions, expected,
      `${p.category}/${p.failure_mode}: verifiedActions=${p.verifiedActions} but counts.recall+alert=${expected}`)
    assert.equal(p.unverifiedReports, p.counts.incident || 0,
      `${p.category}/${p.failure_mode}: unverifiedReports should equal counts.incident`)
  }
})
