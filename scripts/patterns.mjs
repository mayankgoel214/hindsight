/* Pipeline step 4 — patterns.
   Groups in-scope extractions by category x failure_mode. For each group it
   computes (in code) counts by kind, injury profile, year span, brands, and
   picks 2-3 example records (verified + quoted + worst injury first). An LLM
   then writes a suggested mitigation / verification test, grounded ONLY in the
   cited example records. Every number in the generated text is checked against
   the computed counts; a sentence with a wrong number is dropped, and if the
   whole text fails it is regenerated once, then dropped.

   The "likely standard" is a per-category hint, phrased "check against",
   never "complies".

   Run: node --env-file=../Portfolio/.env.local scripts/patterns.mjs
*/
import { join } from "node:path";
import { P, readJson, writeJson, logger, requireKey, clip, yearOf } from "./lib/util.mjs";
import { genJSON, makeCost, pool, TEXT_MODEL } from "./lib/gemini.mjs";
import { STANDARD_HINT } from "./lib/taxonomy.mjs";
import { fmCanonical } from "./lib/canon.mjs";

const log = logger("patterns");
const INJURY_RANK = { none: 0, minor: 1, medical: 2, serious: 3 };

function computeGroup(cat, fm, recs) {
  const byKind = { recall: 0, incident: 0, alert: 0 };
  const brands = new Map();
  const years = [];
  const injuries = { none: 0, minor: 0, medical: 0, serious: 0 };
  let injuredReports = 0, totalUnits = 0;
  for (const r of recs) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    // Prefer the canonical display name so topBrands matches what the UI shows
    // (and so manufacturer variants collapse into one entry).
    const brandList = (r.brands_canon?.length ? r.brands_canon.map((c) => c.display) : r.brands) || [];
    for (const b of brandList) if (b) brands.set(b, (brands.get(b) || 0) + 1);
    const y = yearOf(r.date); if (y) years.push(y);
    injuries[r.extract.injury] = (injuries[r.extract.injury] || 0) + 1;
    if (r.extract.injury !== "none") injuredReports++;
    if (r.units) totalUnits += r.units;
  }
  const examples = [...recs]
    .sort((a, b) =>
      (INJURY_RANK[b.extract.injury] - INJURY_RANK[a.extract.injury]) ||
      ((b.verified - a.verified)) ||
      ((b.extract.quote_status !== "unsupported") - (a.extract.quote_status !== "unsupported")))
    .filter((r) => r.extract.quote_status !== "unsupported")
    .slice(0, 3);
  return {
    category: cat,
    failure_mode: fm,
    total: recs.length,
    counts: byKind,
    // Verified regulator actions = CPSC/Health Canada recalls + EU Safety Gate alerts.
    // Named `verifiedActions` (not `recalls`) so the UI never conflates alerts with recalls
    // and so the number here cannot disagree with `counts.recall`.
    verifiedActions: byKind.recall + byKind.alert,
    unverifiedReports: byKind.incident, // consumer reports, always labeled as such
    injuries,
    injuredReports,
    unitsAffected: totalUnits || null,
    years: years.length ? [Math.min(...years), Math.max(...years)] : null,
    topBrands: [...brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n })),
    standardHint: STANDARD_HINT[cat] || null,
    exampleIds: examples.map((r) => r.id),
    _examples: examples, // stripped before write
  };
}

const schema = {
  type: "OBJECT",
  properties: {
    mitigation: { type: "STRING", description: "one or two sentences: the design mitigation this pattern calls for" },
    verification: { type: "STRING", description: "one concrete bench/verification test an engineer can run" },
  },
  required: ["mitigation", "verification"],
};

function buildPrompt(g) {
  const ex = g._examples.map((r, i) =>
    `[${i + 1}] (${r.kind}${r.verified ? "" : ", unverified"}, ${yearOf(r.date)}) ${clip(r.product, 90)}\n    quote: "${r.extract.quote}"\n    component: ${r.extract.component}; effect: ${r.extract.effect}`).join("\n");
  const system = `You are a reliability engineer writing DFMEA mitigation guidance for small kitchen appliances.
Ground every statement ONLY in the cited example records below. Do not add failure modes, causes, numbers, standards, or injuries that are not in them.
Do NOT state counts or statistics — another system fills those in. Write about the engineering, not the data.
Write plainly and specifically. Two short sentences max each.`;
  const user = `Category: ${g.category}
Failure mode: ${g.failure_mode.replace(/_/g, " ")}

Cited example records:
${ex}

Write:
- mitigation: the design change(s) that would prevent this failure mode.
- verification: one concrete test to confirm the mitigation works.`;
  return { system, user };
}

// Reject any integer in the text that is not one of the computed numbers for
// this group (counts, years, units). Prevents fabricated statistics. Standard
// part numbers (IEC/UL 60335, 60335-2-15, 60601, 60601-1, …) are allowed.
const STANDARD_NUMS = new Set(["60335", "60601"]);
const STANDARD_PART = /^2-\d{1,3}$/;
function isStandardNumber(n) {
  return STANDARD_NUMS.has(String(n)) || STANDARD_PART.test(String(n));
}
function numbersOk(text, g) {
  const allowed = new Set([
    g.total, g.verifiedActions, g.unverifiedReports, g.injuredReports, g.unitsAffected,
    ...(g.years || []), ...Object.values(g.counts), ...Object.values(g.injuries),
  ].filter((n) => n != null).map(String));
  // Pull "60335-2-15"-style tokens whole so we don't split them into 60335 / 2 / 15.
  const stripped = text.replace(/\b(?:IEC|UL|EN)?\s*\/?\s*(?:IEC|UL|EN)?\s*\d{3,5}(?:-\d+)*/g, (m) => {
    // Keep only well-known standards; drop everything else from the text so
    // the number check doesn't see them.
    return /\b60335|60601\b/.test(m) ? "" : m;
  });
  const nums = (stripped.match(/\d[\d,]*/g) || []).map((s) => s.replace(/,/g, ""));
  for (const n of nums) {
    if (allowed.has(n)) continue;
    if (isStandardNumber(n)) continue;
    return false;
  }
  return true;
}

async function main() {
  const apiKey = requireKey();
  const extracted = await readJson(join(P.cache, "extracted.json"));
  // group by category x failure_mode. Canonicalize "other:*" via lib/canon.mjs
  // so "glass lid shattered"/"shattered glass lid"/… merge into one pattern.
  const groups = new Map();
  for (const r of extracted) {
    const cat = r.categories[0];
    const c = fmCanonical(cat, r.extract.failure_mode, r.extract.failure_mode_label);
    // Mutate the record's extract in-place so downstream (meta.json via re-embed, DFMEA export) sees the canon label.
    r.extract.failure_mode = c.failure_mode;
    r.extract.failure_mode_label = c.failure_mode_label;
    const fm = c.failure_mode === "other" ? `other:${c.failure_mode_label || "other"}` : c.failure_mode;
    const key = `${cat}|${fm}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  // Keep every pattern — even a single-record one. A one-off recall is still
  // a real failure the engineer needs to see. For single-record patterns we
  // skip the LLM mitigation/verification write-up (not enough signal to
  // ground against, and it'd cost tokens for marginal value); the UI shows
  // them with just the counts + the one example.
  const computed = [];
  for (const [key, recs] of groups) {
    const [cat, fm] = key.split("|");
    const g = computeGroup(cat, fm, recs);
    g._singleRecord = recs.length < 2;
    computed.push(g);
  }
  computed.sort((a, b) => (INJURY_RANK[worst(b.injuries)] - INJURY_RANK[worst(a.injuries)]) || (b.total - a.total));
  log.info(`${computed.length} patterns (category x failure_mode, >=2 records)`);

  const cost = makeCost();
  let dropped = 0, done = 0;
  await pool(computed, 4, async (g) => {
    if (g._examples.length === 0 || g._singleRecord) { g.mitigation = null; g.verification = null; g.standard = g.standardHint ? `Check against ${g.standardHint}.` : null; return; }
    const r = await gen(g, apiKey, cost);
    let m = r?.mitigation || "", v = r?.verification || "";
    if (m && !numbersOk(m, g)) { const r2 = await gen(g, apiKey, cost); if (r2 && numbersOk(r2.mitigation, g)) m = r2.mitigation; else { m = ""; dropped++; } }
    if (v && !numbersOk(v, g)) { v = ""; dropped++; }
    g.mitigation = m ? clip(m, 320) : null;
    g.verification = v ? clip(v, 320) : null;
    g.standard = g.standardHint ? `Check against ${g.standardHint}.` : null;
    done++;
    if (done % 20 === 0 || done === computed.length) log.info(`${done}/${computed.length} | ${cost.summary()}`);
  });

  for (const g of computed) { delete g._examples; delete g.standardHint; delete g._singleRecord; }
  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    model: TEXT_MODEL,
    note: "Counts are computed from the records. `verifiedActions` = CPSC/Health Canada recalls + EU Safety Gate alerts (both verified regulator actions). `unverifiedReports` = consumer incident reports (always labeled as such, never shown as recalls). Mitigation/verification text is model-generated, grounded only in cited example records, and number-checked.",
    patterns: computed,
  };
  await writeJson(join(P.pub, "patterns.json"), out);
  log.info(`wrote ${computed.length} patterns -> public/data/patterns.json (number-check drops=${dropped}) | ${cost.summary()}`);
}

async function gen(g, apiKey, cost) {
  const { system, user } = buildPrompt(g);
  const r = await genJSON({ apiKey, model: TEXT_MODEL, system, userText: user, schema, maxOutputTokens: 4096, temperature: 0.2, thinkingLevel: "low" });
  if (r.usage) cost.addGen(TEXT_MODEL, r.usage);
  return r.parsed;
}

const worst = (inj) => (inj.serious ? "serious" : inj.medical ? "medical" : inj.minor ? "minor" : "none");

main().catch((e) => { log.err(e); process.exit(1); });
