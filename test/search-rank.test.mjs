/* Ranking + category-boost tests. Pure, no network. Uses the real
   patterns.json + meta-index.json so the ranking is validated against
   current pipeline output — if the boost regresses, these tests catch it. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { rankPatterns, detectCategoriesInQuery } from "../public/lib/search-rank.js"

const patterns = JSON.parse(await readFile(new URL("../public/data/patterns.json", import.meta.url), "utf8"))
const metaIdx = JSON.parse(await readFile(new URL("../public/data/meta-index.json", import.meta.url), "utf8"))
const patternByKey = new Map()
for (const p of patterns.patterns) {
  const fm = p.failure_mode === "other" ? `other:${p.failure_mode_label || "other"}` : p.failure_mode
  patternByKey.set(`${p.category}|${fm}`, p)
}
const byId = new Map(metaIdx.records.map((r) => [r.id, r]))
// Helper: synthesize `hits` by picking the N highest-scoring records in a
// pattern (score falls off linearly), given a seed category + failure_mode.
function hitsForPattern({ category, failure_mode, label }, { topScore = 0.80, n = 15 }) {
  const recs = metaIdx.records.filter((r) => r.category === category && r.failure_mode === failure_mode &&
    (!label || (r.failure_mode_label || "").toLowerCase() === label.toLowerCase())).slice(0, n)
  return recs.map((r, i) => ({ id: r.id, score: topScore - i * 0.005 }))
}

test("detectCategoriesInQuery: catches all v1 category aliases", () => {
  assert.deepEqual([...detectCategoriesInQuery("glass air fryer basket shatters")], ["air_fryer"])
  assert.deepEqual([...detectCategoriesInQuery("pressure cooker lid opens while hot")], ["pressure_multi_cooker"])
  assert.deepEqual([...detectCategoriesInQuery("blender blade assembly comes loose")], ["blender_food_processor"])
  assert.deepEqual([...detectCategoriesInQuery("espresso machine steam wand burn")], ["coffee_maker"])
  assert.deepEqual([...detectCategoriesInQuery("kettle handle separates")], ["kettle"])
  assert.deepEqual([...detectCategoriesInQuery("ice cream maker blade")], ["ice_cream_frozen_drink"])
  assert.deepEqual([...detectCategoriesInQuery("toaster oven door")], ["oven_toaster"])
  assert.deepEqual([...detectCategoriesInQuery("pellet grill flare up")], ["grill"])
  assert.deepEqual([...detectCategoriesInQuery("instant pot lid")], ["pressure_multi_cooker"])
})

test("detectCategoriesInQuery: query without a category term returns empty", () => {
  assert.equal(detectCategoriesInQuery("something broke").size, 0)
  assert.equal(detectCategoriesInQuery("").size, 0)
  assert.equal(detectCategoriesInQuery(null).size, 0)
})

test("ranking: category boost puts air_fryer first for the glass-basket query", () => {
  // Synthesize: strong hits across air_fryer glass + oven_toaster door glass.
  const hits = [
    ...hitsForPattern({ category: "air_fryer", failure_mode: "glass_component_shattering" }, { topScore: 0.78, n: 10 }),
    ...hitsForPattern({ category: "oven_toaster", failure_mode: "door_glass_shattering" }, { topScore: 0.80, n: 60 }),
    ...hitsForPattern({ category: "pressure_multi_cooker", failure_mode: "glass_lid_shattering" }, { topScore: 0.79, n: 40 }),
  ]
  const queryCategories = detectCategoriesInQuery("glass air fryer basket shatters")
  const ranked = rankPatterns({ hits, recByKey: byId, patternByKey, queryCategories })
  assert.ok(ranked.length >= 1)
  assert.equal(ranked[0].category, "air_fryer",
    `expected air_fryer #1 but got ${ranked[0].category}/${ranked[0].pattern.failure_mode}; top3=${ranked.slice(0,3).map(r=>r.category).join(",")}`)
})

test("ranking: without boost, oven_toaster's higher topScore wins (sanity: boost is doing the work)", () => {
  const hits = [
    ...hitsForPattern({ category: "air_fryer", failure_mode: "glass_component_shattering" }, { topScore: 0.78, n: 10 }),
    ...hitsForPattern({ category: "oven_toaster", failure_mode: "door_glass_shattering" }, { topScore: 0.80, n: 60 }),
  ]
  const ranked = rankPatterns({ hits, recByKey: byId, patternByKey, queryCategories: new Set() })
  assert.equal(ranked[0].category, "oven_toaster")
})

test("chip queries: each example chip puts a pattern in the expected category #1", () => {
  // For each chip, synthesize a plausible hit set (one strong hit in the expected
  // category + a stronger-top distractor in another category) and confirm the
  // category boost pulls the expected category to the top. Target failure_mode
  // is chosen to be a pattern we know exists in the data today.
  const chips = [
    { q: "pressure cooker lid opens while hot", expectCategory: "pressure_multi_cooker", target: "lid_opens_under_pressure", distractors: [{ category: "oven_toaster", failure_mode: "door_glass_shattering" }] },
    { q: "glass air fryer basket shatters", expectCategory: "air_fryer", target: "glass_component_shattering", distractors: [{ category: "oven_toaster", failure_mode: "door_glass_shattering" }, { category: "pressure_multi_cooker", failure_mode: "glass_lid_shattering" }] },
    { q: "blender blade assembly comes loose", expectCategory: "blender_food_processor", target: "blade_detachment_or_breakage", distractors: [{ category: "ice_cream_frozen_drink", failure_mode: "blade_paddle_breakage" }] },
    { q: "espresso machine steam wand burn", expectCategory: "coffee_maker", target: "hot_liquid_or_steam_ejection", distractors: [{ category: "pressure_multi_cooker", failure_mode: "lid_opens_under_pressure" }] },
    { q: "kettle handle separates", expectCategory: "kettle", target: "lid_failure_or_ejection", distractors: [{ category: "coffee_maker", failure_mode: "carafe_glass_shattering" }] },
    { q: "ice cream maker blade", expectCategory: "ice_cream_frozen_drink", target: "blade_paddle_breakage", distractors: [{ category: "blender_food_processor", failure_mode: "blade_detachment_or_breakage" }] },
  ]
  for (const chip of chips) {
    const hits = [
      ...hitsForPattern({ category: chip.expectCategory, failure_mode: chip.target }, { topScore: 0.78, n: 10 }),
      ...chip.distractors.flatMap((d) => hitsForPattern(d, { topScore: 0.80, n: 30 })),
    ]
    const ranked = rankPatterns({ hits, recByKey: byId, patternByKey, queryCategories: detectCategoriesInQuery(chip.q) })
    assert.ok(ranked.length > 0, `chip "${chip.q}": no results ranked`)
    assert.equal(ranked[0].category, chip.expectCategory,
      `chip "${chip.q}": expected ${chip.expectCategory} first, got ${ranked[0].category}/${ranked[0].pattern.failure_mode}`)
  }
})
