/* Pure helpers for pattern-aware search ranking. No DOM, no browser APIs,
   so this is unit-testable from Node. Shared by public/app.js and
   test/search-rank.test.mjs. */

const INJURY_RANK = { none: 0, minor: 1, medical: 2, serious: 3 }
function worstInjury(injuries = {}) {
  if (injuries.serious) return "serious"
  if (injuries.medical) return "medical"
  if (injuries.minor) return "minor"
  return "none"
}

/* Query → set of category slugs mentioned (by keyword). Case-insensitive.
   Returns a Set so callers can test with any lookup pattern. */
const CATEGORY_KEYWORDS = {
  air_fryer: [/\bair[\s-]?fry(?:er|ing)?\b/i, /\bairfryer\b/i],
  pressure_multi_cooker: [/\bpressure\s*cooker\b/i, /\bmulti[\s-]?cooker\b/i, /\binstant\s*pot\b/i, /\bfoodi\b/i, /\bcrock[\s-]?pot\b/i],
  blender_food_processor: [/\bblender\b/i, /\bfood\s*processor\b/i, /\bjuicer\b/i, /\bblendjet\b/i, /\btumbler\s*blender\b/i],
  // Keep /\bbrewer\b/ and /\bpod\b/ narrow: a bare "brewer" or "pod" could match
  // kettle-brewers or pressure-cooker pods, so require a coffee context.
  coffee_maker: [/\bcoffee\b/i, /\bespresso\b/i, /\bkeurig\b/i, /\bcafé\b/i, /\bcafe\b/i, /\bk[-\s]?cup\b/i, /\bcoffee\s*brewer\b/i, /\bsingle[-\s]?serve\b/i, /\bcoffee\s*pod\b/i, /\bk[-\s]?pod\b/i],
  kettle: [/\bkettle\b/i, /\belectric\s*kettle\b/i],
  oven_toaster: [/\btoaster\b/i, /\btoaster\s*oven\b/i, /\bcountertop\s*oven\b/i, /\bconvection\s*oven\b/i],
  grill: [/\bgrill\b/i, /\bgriddle\b/i, /\bpellet\b/i, /\bwoodfire\b/i, /\bbarbecue\b/i, /\bbbq\b/i],
  ice_cream_frozen_drink: [/\bice\s*cream\b/i, /\bcreami\b/i, /\bslush(?:ie|i)?\b/i, /\bfrozen\s*(?:drink|dessert|treat)\b/i, /\bgelato\b/i, /\bsorbet\b/i],
}

export function detectCategoriesInQuery(q) {
  const out = new Set()
  const s = String(q || "")
  for (const [cat, patterns] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const re of patterns) if (re.test(s)) { out.add(cat); break }
  }
  return out
}

/* Build a pattern-level ranking from a flat list of hits.
   `patternByKey.get("category|failure_mode[:label]")` returns the pattern
   from patterns.json (with injuries + verifiedActions etc.).
   `recByKey.get(id)` returns a lite record with .category/.failure_mode/.failure_mode_label.
   Returns [{ key, pattern, topScore, hitCount, matchedIds: Set, rank }] sorted desc.
*/
export function rankPatterns({ hits, recByKey, patternByKey, queryCategories = new Set() }) {
  const bins = new Map()
  for (const h of hits) {
    const rec = recByKey.get(h.id); if (!rec) continue
    const fm = rec.failure_mode === "other" ? `other:${rec.failure_mode_label || "other"}` : rec.failure_mode
    const key = `${rec.category}|${fm}`
    const slot = bins.get(key) || { key, category: rec.category, pattern: patternByKey.get(key), topScore: 0, hitCount: 0, matchedIds: new Set() }
    slot.hitCount++
    if (h.score > slot.topScore) slot.topScore = h.score
    slot.matchedIds.add(h.id)
    bins.set(key, slot)
  }
  // Rank: topScore dominates; log breadth bonus; worst-injury tie-break;
  // explicit category boost when the query names that category.
  for (const s of bins.values()) {
    if (!s.pattern) continue
    const sev = INJURY_RANK[worstInjury(s.pattern.injuries)] || 0
    const catBoost = queryCategories.has(s.category) ? 0.5 : 0
    s.rank = s.topScore * 3 + Math.log(1 + s.hitCount) * 0.1 + sev * 0.05 + catBoost
  }
  return [...bins.values()].filter((s) => s.pattern).sort((a, b) => b.rank - a.rank)
}
