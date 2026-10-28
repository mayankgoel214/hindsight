import { toCSV, toTSV } from "/lib/dfmea-export.js"
import { rankPatterns, detectCategoriesInQuery } from "/lib/search-rank.js"
/* Hindsight client. One static page, five views. No framework, no npm deps.
   Pattern-aware search: a query hits /api/search (returns top ids+scores);
   client aggregates hits into patterns via patterns.json and renders
   full-pattern stats + verified-recall-first examples.
   Lazy-loads meta.json on the first search (keeps first paint small). */

// ── Config ────────────────────────────────────────────────────────────
const MIN_SCORE = 0.35
const TOPK = 200
const PATTERN_LIMIT = 8
const VERIFIED_EXAMPLES = 3
const UNVERIFIED_EXAMPLES = 3
const SIMILAR_RECORDS = 10

// Pretty "intended function" per failure mode — short, engineer-worded.
const FUNCTION_FOR_FM = {
  lid_opens_under_pressure: "Lid retains seal while the vessel is pressurized",
  lid_interlock_failure: "Lid interlock prevents opening while pressurized",
  overpressure_rupture_explosion: "Vessel contains cooking pressure within its rated limit",
  hot_contents_eruption: "Lid vents cooking pressure without ejecting contents",
  overheat_scorching: "Heating element delivers set temperature without overheat",
  seal_gasket_failure: "Gasket maintains a pressure seal across use cycles",
  pressure_release_valve_failure: "Pressure-release valve relieves overpressure on demand",
  electrical_fault_shock: "Enclosure isolates mains voltage from the user",
  handle_body_breakage: "Handle supports the loaded vessel without failing",
  blade_detachment_or_breakage: "Blade assembly stays retained during operation and pour",
  jar_container_cracking_shattering: "Jar contains contents under rated motor speed",
  lid_failure_contents_ejection: "Lid retains contents during blending",
  motor_overheat_fire_smoke: "Motor delivers rated power without overheating",
  coupling_drive_failure: "Drive coupling transmits torque without failing",
  laceration_during_handling_cleaning: "Blade is isolated during handling and cleaning",
  unexpected_activation: "Appliance activates only on an intentional user command",
  glass_lid_shattering: "Glass lid withstands thermal and pressure cycling",
  glass_component_shattering: "Glass component withstands thermal and mechanical loads",
  overheating_fire: "Heating assembly operates within thermal limits",
  smoke_emission: "Cooking cycle completes without smoke emission",
  basket_coating_degradation: "Basket coating survives expected use cycles",
  auto_start_or_wont_turn_off: "Power control engages and disengages on command",
  handle_door_latch_failure: "Door latch retains the door through heat cycles",
  plastic_melting_deformation: "Plastic housings tolerate adjacent operating temperatures",
  blade_paddle_breakage: "Blade/paddle survives rated operating load",
  container_bowl_cracking: "Bowl withstands freeze–churn thermal cycle",
  motor_overheat: "Motor stays within thermal limits across cycle",
  pressure_or_contents_ejection: "Lid retains frozen mixture during churn",
  laceration_during_handling: "Blade is isolated during handling and cleaning",
  carafe_glass_shattering: "Carafe glass withstands brewing thermal shock",
  hot_liquid_or_steam_ejection: "Brew head retains hot liquid and steam",
  overheating_fire_smoke: "Heating element and controls stay within thermal limits",
  scald_during_normal_use: "External surfaces stay below scald threshold during use",
  leak_water_into_electrics: "Water paths are isolated from electrical components",
  pressure_valve_failure: "Brew-pressure control relieves overpressure on demand",
}
const FUNCTION_FALLBACK = "operates its intended function safely"

// ── State ─────────────────────────────────────────────────────────────
const state = {
  metaIndex: null,
  meta: null,              // lazy
  metaPromise: null,
  byId: new Map(),         // id -> full record (lazy)
  byIdLite: new Map(),     // id -> lite record (from meta-index)
  patterns: null,
  patternByKey: new Map(), // "cat|fm" -> pattern
  recordsByPattern: new Map(), // "cat|fm" -> record ids (built once meta loads)
  evalData: null,
  categoryNames: new Map(),
  brands: new Map(),       // display -> count
  lastHits: [],            // raw [{id, score}]
  lastQuery: "",
}

// ── Helpers ───────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const safe = (s) => (s == null ? "" : String(s))
const esc = (s) => safe(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

function titleCase(s) {
  const small = new Set(["and", "or", "of", "the", "on", "in", "to", "a", "an", "for", "with"])
  return String(s || "").split(/\s+/).filter(Boolean).map((w, i) =>
    (i > 0 && small.has(w.toLowerCase())) ? w.toLowerCase() : (w[0]?.toUpperCase() || "") + w.slice(1).toLowerCase()
  ).join(" ")
}
function fmNice(fm, label) {
  if (!fm) return "Unknown"
  if (fm === "other") return titleCase((label || "other").replace(/^other:/, ""))
  if (fm.startsWith("other:")) return titleCase(fm.slice(6))
  return titleCase(fm.replace(/_/g, " "))
}
function catNice(cat) {
  const map = {
    pressure_multi_cooker: "Pressure & multi-cookers",
    air_fryer: "Air fryers",
    blender_food_processor: "Blenders & food processors",
    ice_cream_frozen_drink: "Ice cream & frozen drinks",
    coffee_maker: "Coffee & espresso",
    kettle: "Kettles",
    oven_toaster: "Countertop ovens & toasters",
    grill: "Grills",
  }
  return map[cat] || titleCase(cat.replace(/_/g, " "))
}
function sourceLabel(rec) {
  if (rec.source === "cpsc_recall") return "CPSC"
  if (rec.source === "healthcanada_recall") return "Health Canada"
  if (rec.source === "eu_safetygate") return "EU Safety Gate"
  if (rec.source === "saferproducts_incident") return "SaferProducts.gov"
  return rec.source || "source"
}
function kindLabel(rec) {
  if (rec.kind === "recall") return "Recall"
  if (rec.kind === "alert") return "Safety alert"
  if (rec.kind === "incident") return "Consumer report"
  return rec.kind
}
function patternKey(cat, fm, label) {
  const f = fm === "other" ? `other:${label || "other"}` : fm
  return `${cat}|${f}`
}
const INJURY_RANK = { none: 0, minor: 1, medical: 2, serious: 3 }
function worstInjury(injuries) {
  if (injuries.serious) return "serious"
  if (injuries.medical) return "medical"
  if (injuries.minor) return "minor"
  return "none"
}
function brandDisplay(rec) {
  if (rec.brands_canon?.length) return rec.brands_canon[0].display
  return rec.brands?.[0] || ""
}
function brandMfg(rec) {
  return rec.brands_canon?.[0]?.manufacturer || ""
}
function pct(x) { return (x == null) ? "–" : `${Math.round(x * 1000) / 10}%` }

// ── Boot ─────────────────────────────────────────────────────────────
async function boot() {
  initTheme()
  wireTabs()
  wireSearch()
  wireFilters()
  wireDfmea()
  wireChecklistControls()
  wireHashRouter()

  const status = $("#searchStatus")
  status.textContent = "Loading data…"
  try {
    const [metaIndex, patterns, evalData] = await Promise.all([
      fetch("/data/meta-index.json").then(r => r.json()),
      fetch("/data/patterns.json").then(r => r.json()),
      fetch("/data/eval.json").then(r => r.json()),
    ])
    state.metaIndex = metaIndex
    state.patterns = patterns
    state.evalData = evalData
    for (const r of metaIndex.records) state.byIdLite.set(r.id, r)
    for (const p of patterns.patterns) {
      state.patternByKey.set(patternKey(p.category, p.failure_mode, p.failure_mode_label), p)
    }
    // Record→pattern index can be built from the lite records (small).
    for (const r of metaIndex.records) {
      const k = patternKey(r.category, r.failure_mode, r.failure_mode_label)
      const list = state.recordsByPattern.get(k) || []
      list.push(r.id); state.recordsByPattern.set(k, list)
    }
    buildFacetsFromIndex()
    renderFilterOptions()
    renderCategories()
    renderChecklist()
    renderAccuracy()
    renderFeatured()
    status.textContent = ""
  } catch (e) {
    status.textContent = "Failed to load data: " + e.message
    status.className = "status error"
  }

  routeFromHash()
}

function buildFacetsFromIndex() {
  for (const r of state.metaIndex.records) {
    state.categoryNames.set(r.category, catNice(r.category))
    for (const b of r.brands || []) {
      const slot = state.brands.get(b) || { display: b, count: 0 }
      slot.count++; state.brands.set(b, slot)
    }
  }
}

function renderFilterOptions() {
  const fCat = $("#fCategory")
  const cats = [...state.categoryNames.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  for (const [slug, name] of cats) {
    const o = document.createElement("option"); o.value = slug; o.textContent = name; fCat.appendChild(o)
  }
  const fBrand = $("#fBrand")
  const brands = [...state.brands.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 60)
  for (const [key, { display, count }] of brands) {
    const o = document.createElement("option"); o.value = key; o.textContent = `${display} (${count})`; fBrand.appendChild(o)
  }
  const cCat = $("#cCategory")
  for (const [slug, name] of cats) {
    const o = document.createElement("option"); o.value = slug; o.textContent = name; cCat.appendChild(o)
  }
}

// Lazy load the full meta.json on first search.
async function loadMeta() {
  if (state.meta) return state.meta
  if (!state.metaPromise) {
    state.metaPromise = fetch("/data/meta.json").then(r => r.json()).then((m) => {
      state.meta = m
      for (const r of m.records) state.byId.set(r.id, r)
      return m
    })
  }
  return state.metaPromise
}

// ── Theme / router ───────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem("hindsight.theme")
  if (saved) document.documentElement.setAttribute("data-theme", saved)
  $("#themeBtn")?.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme")
    const next = cur === "dark" ? "light" : "dark"
    document.documentElement.setAttribute("data-theme", next)
    try { localStorage.setItem("hindsight.theme", next) } catch {}
  })
}
function wireTabs() {
  $$('[data-view]').forEach(btn => btn.addEventListener("click", () => { location.hash = `#/${btn.dataset.view}` }))
}
function wireHashRouter() { addEventListener("hashchange", routeFromHash) }
function routeFromHash() {
  const m = location.hash.match(/^#\/(\w+)/); setView(m ? m[1] : "search")
}
function setView(v) {
  const allowed = new Set(["search", "categories", "checklist", "accuracy", "about"])
  if (!allowed.has(v)) v = "search"
  $$('[data-view]').forEach(b => b.setAttribute("aria-selected", b.dataset.view === v ? "true" : "false"))
  $$(".view").forEach(sec => sec.hidden = sec.id !== `view-${v}`)
  window.scrollTo({ top: 0 })
}

// ── Featured patterns (empty-state landing) ──────────────────────────
function renderFeatured() {
  const grid = $("#featuredGrid")
  if (!grid) return
  // Rank by regulator actions + 5x serious injuries + log(total)
  const ranked = [...state.patterns.patterns].map((p) => ({
    p, score: (p.verifiedActions || 0) * 5 + (p.injuries.serious || 0) * 10 + (p.injuries.medical || 0) * 2 + Math.log(1 + p.total),
  })).sort((a, b) => b.score - a.score).slice(0, 8)
  grid.innerHTML = ""
  for (const { p } of ranked) {
    const el = document.createElement("button")
    el.type = "button"; el.className = "feat"
    el.innerHTML = `
      <div class="feat-fm">${esc(fmNice(p.failure_mode, p.failure_mode_label))}</div>
      <div class="feat-cat">${esc(catNice(p.category))}</div>
      <div class="feat-stats">
        <span>${p.verifiedActions} regulator action${p.verifiedActions === 1 ? "" : "s"}</span>
        <span>${p.unverifiedReports.toLocaleString()} unverified report${p.unverifiedReports === 1 ? "" : "s"}</span>
        ${p.injuries.serious ? `<span class="feat-ser">${p.injuries.serious} serious injur${p.injuries.serious === 1 ? "y" : "ies"}</span>` : ""}
        ${p.unitsAffected ? `<span>~${(p.unitsAffected / 1e6).toFixed(p.unitsAffected > 1e6 ? 1 : 2)}M units</span>` : ""}
      </div>`
    el.addEventListener("click", () => {
      const q = `${fmNice(p.failure_mode, p.failure_mode_label)} ${catNice(p.category)}`
      $("#q").value = q; location.hash = "#/search"; setView("search"); doSearch(q)
    })
    grid.appendChild(el)
  }
}

// ── Search ───────────────────────────────────────────────────────────
function wireSearch() {
  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault()
    const q = $("#q").value.trim()
    if (q.length < 3) return
    doSearch(q)
  })
  $$("#exampleChips .chip").forEach((c) => c.addEventListener("click", () => {
    $("#q").value = c.textContent; doSearch(c.textContent)
  }))
}
function wireFilters() {
  $$("#filters select, #filters input").forEach((el) => el.addEventListener("change", renderSearchResults))
}

async function doSearch(q) {
  state.lastQuery = q
  const status = $("#searchStatus")
  status.className = "status"; status.textContent = "Searching…"
  $("#searchResults").innerHTML = ""
  $("#similarRecords").hidden = true
  $("#dfmeaRows").hidden = true
  $("#featured").hidden = true
  $("#filters").hidden = false
  try {
    // Fire both in parallel: the server search and the lazy meta load.
    const [sres] = await Promise.all([
      fetch("/api/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ q, k: TOPK }),
      }).then(r => r.json()),
      loadMeta(),
    ])
    if (sres.fallback) {
      const msg = { quota: "AI quota reached. Try again in a few minutes.", daily_cap: "Daily request cap reached. Try again tomorrow.",
        visitor_limit: "You've hit the hourly limit. Try again shortly.",
        unavailable: "Search is temporarily unavailable.", model_error: "The AI service returned an error. Try again." }[sres.reason] || "Search is temporarily unavailable."
      status.textContent = msg; status.className = "status error"; return
    }
    if (!sres.results) {
      status.textContent = "Search failed: " + (sres.error || "unknown"); status.className = "status error"; return
    }
    state.lastHits = sres.results.filter(x => x.score >= MIN_SCORE)
    status.textContent = ""
    renderSearchResults()
  } catch (e) {
    status.textContent = "Network error: " + e.message; status.className = "status error"
  }
}

// Apply filters at the pattern-group level (same filters still apply to records
// inside the group). The idea is to filter records first, then re-aggregate.
function filterHits(hits) {
  const cat = $("#fCategory").value
  const src = $("#fSource").value
  const brand = $("#fBrand").value
  const ymin = Number($("#fYearMin").value) || null
  const ymax = Number($("#fYearMax").value) || null
  const sharkOnly = $("#fSharkninja").checked
  return hits.filter(h => {
    const r = state.byId.get(h.id)
    if (!r) return false
    if (cat && r.category !== cat) return false
    if (src === "verified" && !r.verified) return false
    if (src === "unverified" && r.verified) return false
    if (sharkOnly && !r.sharkninja) return false
    if (brand) {
      const names = (r.brands_canon || []).map((b) => b.display)
      if (!names.includes(brand)) return false
    }
    if (ymin && (r.year || 0) < ymin) return false
    if (ymax && (r.year || 9999) > ymax) return false
    return true
  })
}

function aggregateByPattern(hits) {
  const queryCategories = detectCategoriesInQuery(state.lastQuery)
  return rankPatterns({
    hits, recByKey: state.byIdLite, patternByKey: state.patternByKey, queryCategories,
  })
}

function renderSearchResults() {
  const container = $("#searchResults")
  container.innerHTML = ""
  if (!state.lastHits.length) {
    container.innerHTML = `<div class="no-match"><strong>No matching record.</strong>
      <p class="muted">Try a broader description, or browse <button class="btn ghost small" onclick="location.hash='#/categories'">Categories</button>.</p></div>`
    $("#dfmeaRows").hidden = true; $("#similarRecords").hidden = true
    $("#featured").hidden = false
    return
  }
  const hits = filterHits(state.lastHits)
  if (!hits.length) {
    container.innerHTML = `<div class="no-match"><strong>No records match these filters.</strong>
      <p class="muted">Loosen a filter to see all matches for "${esc(state.lastQuery)}".</p></div>`
    $("#dfmeaRows").hidden = true; $("#similarRecords").hidden = true; return
  }
  const groups = aggregateByPattern(hits).slice(0, PATTERN_LIMIT)
  for (const g of groups) container.appendChild(renderPattern(g))
  renderDfmea(groups)
  renderSimilarRecords(hits.slice(0, SIMILAR_RECORDS))
}

function renderPattern(g) {
  const p = g.pattern
  const examples = examplesFor(g.key, g.matchedIds)
  const years = p.years ? `${p.years[0]}–${p.years[1]}` : ""
  const units = p.unitsAffected ? `~${p.unitsAffected.toLocaleString()} units` : ""
  const topBrands = (p.topBrands || []).slice(0, 4).map((b) => b.name).join(" · ")
  const injChips = [
    p.injuries.serious ? `<span class="stat injury-serious">${p.injuries.serious} serious</span>` : "",
    p.injuries.medical ? `<span class="stat injury-medical">${p.injuries.medical} medical</span>` : "",
    p.injuries.minor ? `<span class="stat injury-minor">${p.injuries.minor} minor</span>` : "",
  ].filter(Boolean).join("")
  const wrap = document.createElement("section")
  wrap.className = "group pattern"
  wrap.innerHTML = `
    <header class="group-head">
      <div class="group-title">
        <div class="fm">${esc(fmNice(p.failure_mode, p.failure_mode_label))}</div>
        <div class="cat">${esc(catNice(p.category))} · full pattern</div>
      </div>
      <div class="group-stats">
        <span class="stat verified">${p.verifiedActions} regulator action${p.verifiedActions === 1 ? "" : "s"}</span>
        <span class="stat unverified">${p.unverifiedReports.toLocaleString()} unverified report${p.unverifiedReports === 1 ? "" : "s"}</span>
        ${injChips}
        ${years ? `<span class="stat">${years}</span>` : ""}
        ${units ? `<span class="stat">${units}</span>` : ""}
      </div>
    </header>
    ${topBrands ? `<div class="group-brands">Brands in this pattern: ${esc(topBrands)}${p.topBrands.length > 4 ? ` +${p.topBrands.length - 4} more` : ""}</div>` : ""}
    ${(p.mitigation || p.verification) ? `<div class="group-notes">
      ${p.mitigation ? `<div><span class="lb">Mitigation</span><span class="mu">(AI, grounded in the examples below)</span><p>${esc(p.mitigation)}</p></div>` : ""}
      ${p.verification ? `<div><span class="lb">Verification test</span><p>${esc(p.verification)}</p></div>` : ""}
      ${p.standard ? `<div class="std-hint">${esc(p.standard)}</div>` : ""}
    </div>` : ""}
    ${examples.verified.length ? `<div class="ex-sub"><h4>Verified recalls / alerts</h4><ol class="rec-list"></ol></div>` : ""}
    ${examples.unverified.length ? `<div class="ex-sub"><h4>Most-matching consumer reports <span class="mu">(unverified)</span></h4><ol class="rec-list"></ol></div>` : ""}
  `
  const [vList, uList] = wrap.querySelectorAll(".rec-list")
  if (examples.verified.length) for (const r of examples.verified) vList.appendChild(renderRecord(r, true))
  if (examples.unverified.length && uList) for (const r of examples.unverified) uList.appendChild(renderRecord(r, false))
  return wrap
}

function examplesFor(key, matchedIds) {
  const ids = state.recordsByPattern.get(key) || []
  const recs = ids.map((id) => state.byId.get(id)).filter(Boolean)
  const verified = recs.filter((r) => r.verified)
    .sort((a, b) => (INJURY_RANK[b.injury] - INJURY_RANK[a.injury]) || ((b.units || 0) - (a.units || 0)))
    .slice(0, VERIFIED_EXAMPLES)
  const unverified = recs.filter((r) => !r.verified && matchedIds.has(r.id))
    .sort((a, b) => (INJURY_RANK[b.injury] - INJURY_RANK[a.injury]))
    .slice(0, UNVERIFIED_EXAMPLES)
  // If no matched unverified (rare), fall back to the top-injury unverified for the pattern.
  if (!unverified.length) {
    const u = recs.filter((r) => !r.verified)
      .sort((a, b) => (INJURY_RANK[b.injury] - INJURY_RANK[a.injury])).slice(0, UNVERIFIED_EXAMPLES)
    return { verified, unverified: u }
  }
  return { verified, unverified }
}

function renderRecord(rec, isVerified) {
  const li = document.createElement("li")
  li.className = "rec" + (isVerified ? " rec-verified" : "")
  const badges = [
    `<span class="badge ${rec.verified ? "b-verified" : "b-unverified"}">${rec.verified ? "Verified" : "Unverified"}</span>`,
    `<span class="badge b-${rec.kind}">${esc(kindLabel(rec))}</span>`,
  ]
  if (rec.injury && rec.injury !== "none") badges.push(`<span class="badge b-injury-${rec.injury}">${rec.injury} injury</span>`)
  const brand = brandDisplay(rec); const mfg = brandMfg(rec)
  const quote = esc(rec.quote || "")
  li.innerHTML = `
    <header class="rec-head">
      <span class="rec-badges">${badges.join("")}</span>
      <a class="rec-source" href="${esc(rec.url)}" target="_blank" rel="noopener">${esc(sourceLabel(rec))} ↗</a>
    </header>
    <div class="rec-product">
      ${brand ? `<span class="rec-brand">${esc(brand)}</span>` : ""}
      ${mfg && mfg.toLowerCase() !== brand.toLowerCase() ? `<span class="rec-mfg">${esc(mfg)}</span>` : ""}
      <span class="rec-prod-name">${esc(rec.product || "(product name not provided)")}</span>
    </div>
    ${quote ? `<blockquote class="rec-quote"><mark>${quote}</mark></blockquote>` : ""}
    <div class="rec-meta">
      <span>${esc(rec.date || "")}</span>
      ${rec.units ? `<span>${rec.units.toLocaleString()} units</span>` : ""}
      <span class="muted" title="AI similarity score (dot product on L2-normalized embeddings)" aria-hidden="true"></span>
    </div>
  `
  return li
}

function renderSimilarRecords(hits) {
  const list = $("#similarList"); list.innerHTML = ""
  for (const h of hits) {
    const r = state.byId.get(h.id); if (!r) continue
    const li = renderRecord(r, r.verified)
    li.title = `Match ${(h.score * 100).toFixed(1)}%`
    list.appendChild(li)
  }
  $("#similarRecords").hidden = !list.children.length
}

// ── DFMEA rows ───────────────────────────────────────────────────────
function wireDfmea() {
  $("#copyTsv").addEventListener("click", () => {
    const rows = buildDfmeaRows(); if (!rows.length) return
    navigator.clipboard.writeText(toTSV(rows)).then(() => flash("#copyTsv", "Copied!")).catch(() => flash("#copyTsv", "Copy failed"))
  })
  $("#downloadCsv").addEventListener("click", () => {
    const rows = buildDfmeaRows(); if (!rows.length) return
    const blob = new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" })
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob)
    a.download = `hindsight-dfmea-${slug(state.lastQuery)}.csv`; a.click(); URL.revokeObjectURL(a.href)
  })
}
function slug(s) { return safe(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "search" }
function flash(sel, msg) { const el = $(sel); const o = el.textContent; el.textContent = msg; setTimeout(() => { el.textContent = o }, 1200) }

function buildDfmeaRows() {
  const hits = filterHits(state.lastHits)
  return aggregateByPattern(hits).slice(0, PATTERN_LIMIT).map(patternToDfmeaRow)
}
function patternToDfmeaRow(g) {
  const p = g.pattern
  const ids = state.recordsByPattern.get(g.key) || []
  const recs = ids.map((id) => state.byId.get(id)).filter(Boolean)
  const topCauses = topFreq(recs.map((r) => r.cause).filter((c) => c && c !== "unknown"), 3).join("; ") || "see linked records"
  const topEffects = topFreq(recs.map((r) => r.effect).filter(Boolean), 2).join("; ") || "see linked records"
  const hazards = [...new Set(recs.map((r) => r.hazard_type).filter(Boolean))].slice(0, 3).join(", ")
  const func = FUNCTION_FOR_FM[p.failure_mode] || `${catNice(p.category)} ${FUNCTION_FALLBACK}`
  const sev = severityHint(p.injuries)
  const evidence = `${p.verifiedActions} regulator action${p.verifiedActions === 1 ? "" : "s"} + ${p.unverifiedReports.toLocaleString()} unverified report${p.unverifiedReports === 1 ? "" : "s"}; ${p.injuredReports} with injury${p.unitsAffected ? `; ~${p.unitsAffected.toLocaleString()} units` : ""}`
  const verif = p.verification || p.mitigation || "Bench-test the failure mode under worst-case consumer use; add detection in DVT plan."
  const stdHint = p.standard ? ` ${p.standard}` : ""
  // Pick 1-3 best source links: prefer verified records, then earliest.
  const vrecs = recs.filter((r) => r.verified).sort((a, b) => (INJURY_RANK[b.injury] - INJURY_RANK[a.injury]) || ((b.units || 0) - (a.units || 0))).slice(0, 3)
  const sources = (vrecs.length ? vrecs : recs.slice(0, 3)).map((r) => ({ label: sourceLabel(r), url: r.url }))
  return {
    function: func,
    failure_mode: fmNice(p.failure_mode, p.failure_mode_label),
    cause: topCauses,
    effect: topEffects + (hazards ? ` (${hazards})` : ""),
    severity: sev, evidence, verification: (verif + stdHint).trim(), sources,
  }
}
function topFreq(arr, n) {
  const map = new Map()
  for (const s of arr) {
    const k = s.toLowerCase().trim().slice(0, 80)
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k)
}
function severityHint(inj) {
  if (inj.serious >= 1) return `High (${inj.serious} serious injur${inj.serious === 1 ? "y" : "ies"} reported)`
  if (inj.medical >= 1) return `Medium–High (${inj.medical} medical-attention)`
  if (inj.minor >= 1) return `Medium (${inj.minor} minor)`
  return "Low–Medium (no injuries reported; failure mode confirmed)"
}
function renderDfmea(groups) {
  const tbody = $("#dfmeaTable tbody"); tbody.innerHTML = ""
  if (!groups.length) { $("#dfmeaRows").hidden = true; return }
  $("#dfmeaRows").hidden = false
  for (const g of groups) {
    const row = patternToDfmeaRow(g)
    const tr = document.createElement("tr")
    tr.innerHTML = `
      <td>${esc(row.function)}</td>
      <td><strong>${esc(row.failure_mode)}</strong></td>
      <td>${esc(row.cause)}</td>
      <td>${esc(row.effect)}</td>
      <td>${esc(row.severity)}</td>
      <td>${esc(row.evidence)}</td>
      <td>${esc(row.verification)}</td>
      <td class="src">${row.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join("")}</td>`
    tbody.appendChild(tr)
  }
}

// ── Categories view ─────────────────────────────────────────────────
function renderCategories() {
  const grid = $("#categoryGrid"); grid.innerHTML = ""
  const byCat = new Map()
  for (const p of state.patterns.patterns) {
    const l = byCat.get(p.category) || []; l.push(p); byCat.set(p.category, l)
  }
  for (const cat of [...byCat.keys()].sort()) {
    const items = byCat.get(cat).sort((a, b) =>
      (INJURY_RANK[worstInjury(b.injuries)] - INJURY_RANK[worstInjury(a.injuries)]) ||
      (b.verifiedActions - a.verifiedActions) || (b.total - a.total)).slice(0, 8)
    const totalRecs = byCat.get(cat).reduce((s, p) => s + p.total, 0)
    const totalInjured = byCat.get(cat).reduce((s, p) => s + p.injuredReports, 0)
    const card = document.createElement("div"); card.className = "cat-card"
    card.innerHTML = `
      <h3>${esc(catNice(cat))}</h3>
      <div class="cat-stat"><span>${items.length} failure mode${items.length === 1 ? "" : "s"} shown</span><span>${totalRecs} records, ${totalInjured} with injury</span></div>
      <ul class="fm-list"></ul>`
    const ul = card.querySelector("ul")
    for (const p of items) {
      const worst = worstInjury(p.injuries)
      const li = document.createElement("li"); if (worst === "serious") li.className = "worst"
      li.innerHTML = `
        <button class="fm-link">
          <div class="fm-name">${esc(fmNice(p.failure_mode, p.failure_mode_label))}</div>
        </button>
        <span class="fm-stat">${p.verifiedActions} action${p.verifiedActions === 1 ? "" : "s"} · ${p.unverifiedReports.toLocaleString()} report${p.unverifiedReports === 1 ? "" : "s"} · ${p.injuredReports} injured</span>`
      li.querySelector("button").addEventListener("click", () => {
        const q = `${fmNice(p.failure_mode, p.failure_mode_label)} ${catNice(cat)}`
        $("#q").value = q; location.hash = "#/search"; setView("search"); doSearch(q)
      })
      ul.appendChild(li)
    }
    grid.appendChild(card)
  }
}

// ── Checklist ────────────────────────────────────────────────────────
function wireChecklistControls() {
  const cat = $("#cCategory"); const gate = $("#cGate")
  const re = () => renderChecklist()
  cat?.addEventListener("change", re); gate?.addEventListener("change", re)
}
function renderChecklist() {
  const body = $("#checklistBody"); if (!body) return
  const cat = $("#cCategory").value || state.patterns.patterns[0]?.category
  const gate = $("#cGate").value
  body.innerHTML = ""
  const pats = state.patterns.patterns.filter(p => p.category === cat)
    .sort((a, b) => (INJURY_RANK[worstInjury(b.injuries)] - INJURY_RANK[worstInjury(a.injuries)]) || (b.verifiedActions - a.verifiedActions) || (b.total - a.total))
    .slice(0, 10)
  if (!pats.length) { body.innerHTML = `<div class="no-match">No patterns yet for this category.</div>`; return }
  const frames = {
    P0: "Before kicking off this program, has the design brief addressed",
    P2: "Before freezing design intent at P2, has the design mitigated",
    DVT: "Before DVT exit, is there a verified test covering",
    TRA: "Before TRA, is there documented evidence closing out",
  }
  const stem = frames[gate] || frames.P0
  for (const p of pats) {
    const fm = fmNice(p.failure_mode, p.failure_mode_label)
    const item = document.createElement("div"); item.className = "check-item"
    item.innerHTML = `
      <input type="checkbox" aria-label="mark complete">
      <div>
        <div class="q">${esc(stem)} <strong>${esc(fm)}</strong>?</div>
        <div class="evidence">Seen in ${p.verifiedActions} regulator action${p.verifiedActions === 1 ? "" : "s"} + ${p.unverifiedReports.toLocaleString()} unverified report${p.unverifiedReports === 1 ? "" : "s"} · ${p.injuredReports} with injury${p.years ? ` · ${p.years[0]}–${p.years[1]}` : ""}.</div>
        ${p.standard ? `<div class="std">${esc(p.standard)}</div>` : ""}
      </div>`
    body.appendChild(item)
  }
}

// ── Accuracy ─────────────────────────────────────────────────────────
function renderAccuracy() {
  const body = $("#accuracyBody"); if (!body || !state.evalData) return
  const e = state.evalData
  body.innerHTML = `
    <div class="acc-grid">
      <div class="acc-stat"><div class="n">${pct(e.extraction.failure_mode_accuracy)}</div><div class="l">Failure-mode accuracy</div><div class="d">On ${e.extraction.scored} hand-labeled records, how often the AI picks the right failure-mode bucket.</div></div>
      <div class="acc-stat"><div class="n">${pct(e.extraction.hazard_type_accuracy)}</div><div class="l">Hazard-type accuracy</div><div class="d">How often it picks the right hazard (burn, fire, laceration, shock, …).</div></div>
      <div class="acc-stat"><div class="n">${pct(e.quote_support_rate)}</div><div class="l">Quote-support rate</div><div class="d">Fraction of extractions where the quote is actually in the source record (code-verified, exact or near).</div></div>
      <div class="acc-stat"><div class="n">${pct(e.retrieval["relevance_hit@10"])}</div><div class="l">Relevance hit@10</div><div class="d">For ${e.retrieval.queries} engineer queries, how often at least one of the top-10 results is in the right category + failure mode.</div></div>
      <div class="acc-stat"><div class="n">${pct(e.retrieval["hit@10"])}</div><div class="l">Strict hit@10</div><div class="d">A conservative lower bound: how often the specific labeled example records are in the top 10 by id. Many near-identical valid matches outrank them.</div></div>
      <div class="acc-stat"><div class="n">${e.corpus.extracted.toLocaleString()}</div><div class="l">Records in the index</div><div class="d">Across CPSC, Health Canada, EU Safety Gate and SaferProducts.gov.</div></div>
    </div>
    <div class="callout"><strong>Why the two retrieval numbers differ.</strong>
      Strict hit@10 asks "is this one labeled record id in the top 10?" — but the corpus has many
      near-identical valid matches (dozens of SaferProducts reports describing the same lid failure).
      The labeled example often gets outranked by an equally correct match, so strict hit@10
      under-reports what the tool actually does. Relevance hit@10 asks the engineering question:
      "did the top 10 bring back the right category + failure mode?"</div>`
}

if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot)
else boot()
