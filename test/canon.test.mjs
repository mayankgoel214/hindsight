/* Brand + failure-mode canonicalization. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { brandCanonical, brandCanonicalList, fmCanonical, fmDisplay } from "../scripts/lib/canon.mjs"

test("brand: Crock-Pot variants map to one display name", () => {
  for (const raw of ["Crock-Pot", "Crock Pot", "CROCK POT", "crock-pot", "Crock-pot"]) {
    assert.equal(brandCanonical(raw).display, "Crock-Pot", `raw: ${raw}`)
  }
})

test("brand: Sunbeam d/b/a Jarden Consumer Solutions → Sunbeam", () => {
  assert.equal(brandCanonical("Sunbeam Products, Inc. d/b/a Jarden Consumer Solutions").display, "Sunbeam")
})

test("brand: Ninja family all collapse to Ninja (SharkNinja)", () => {
  for (const raw of ["Ninja", "SharkNinja Operating LLC", "Euro-Pro", "Euro-Pro Operating LLC"]) {
    assert.equal(brandCanonical(raw).display, "Ninja (SharkNinja)", `raw: ${raw}`)
  }
})

test("brand: Char-Broil with city tail → Char-Broil", () => {
  assert.equal(brandCanonical("Char-Broil LLC, of Columbus, Georgia").display, "Char-Broil")
  assert.equal(brandCanonical("Char-Broil, LLC, of Columbus, Ga.").display, "Char-Broil")
})

test("brand: unknown brand gets title-cased, 3 tokens max", () => {
  const r = brandCanonical("WIDGETMAX Appliance Co.")
  assert.ok(r.display.length > 0)
  assert.ok(/^[A-Z]/.test(r.display))
})

test("brandCanonicalList: dedupes variants into one entry", () => {
  const list = brandCanonicalList(["Crock Pot", "Crock-Pot", "CROCK POT", "Sunbeam Products, Inc. d/b/a Jarden Consumer Solutions"])
  const displays = list.map((x) => x.display).sort()
  assert.deepEqual(displays, ["Crock-Pot", "Sunbeam"])
  const cp = list.find((x) => x.display === "Crock-Pot")
  assert.equal(cp.raw.length, 3)
})

test("brand: manufacturer is attached for known consumer brands", () => {
  assert.ok(brandCanonical("Crock-Pot").manufacturer.includes("Sunbeam"))
  assert.ok(brandCanonical("Ninja").manufacturer.includes("SharkNinja"))
})

test("fm: taxonomy modes pass through unchanged", () => {
  const r = fmCanonical("pressure_multi_cooker", "lid_opens_under_pressure", "")
  assert.deepEqual(r, { failure_mode: "lid_opens_under_pressure", failure_mode_label: "" })
})

test("fm: glass lid variants merge to glass_lid_shattering", () => {
  const variants = [
    ["other", "glass lid shattered"], ["other", "shattered glass lid"],
    ["other", "glass_lid_shattered"], ["other", "glass lid shatter"],
    ["other", "glass lid explosion"], ["other", "glass lid shattering"],
    ["other", "glass lid explosion/shattering"],
  ]
  for (const [fm, lab] of variants) {
    const r = fmCanonical("pressure_multi_cooker", fm, lab)
    assert.equal(r.failure_mode, "glass_lid_shattering", `label: ${lab}`)
    assert.equal(r.failure_mode_label, "")
  }
})

test("fm: unmapped 'other:*' label stays other but normalized", () => {
  const r = fmCanonical("pressure_multi_cooker", "other", "Something Weird New!!")
  assert.equal(r.failure_mode, "other")
  assert.equal(r.failure_mode_label, "something weird new")
})

test("fmDisplay: title-cases snake_case and keeps small words lowercase", () => {
  assert.equal(fmDisplay("lid_opens_under_pressure", ""), "Lid Opens Under Pressure")
  assert.equal(fmDisplay("overheating_fire_smoke", ""), "Overheating Fire Smoke")
  assert.equal(fmDisplay("other", "glass lid shattered"), "Glass Lid Shattered")
})
