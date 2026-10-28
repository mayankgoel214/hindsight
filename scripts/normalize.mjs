/* Pipeline step 1 — normalize.
   Reads the four raw appliance subsets, maps each source to a common record
   shape, keeps only v1 Ninja categories, drops obvious out-of-scope rows, does
   a light cross-source dedup (joint US/Canada recalls), writes data/records.json.

   No AI, no network. Run: node scripts/normalize.mjs */
import { join } from "node:path";
import { P, readJson, writeJson, logger, parseUnits, toISO, yearOf, parseInjuryCount, injuryTypes, severityToInjury, sha256, clip } from "./lib/util.mjs";
import { V1_CATEGORIES } from "./lib/taxonomy.mjs";
import { brandCanonicalList } from "./lib/canon.mjs";

const log = logger("normalize");
const V1 = new Set(V1_CATEGORIES);
const inV1 = (cats) => (cats || []).filter((c) => V1.has(c));

// Keyword drops for known false positives the category classifier lets through.
// grill stands / accessories, propane/gas patio heaters, decorations.
const DROP = [
  /\bgrill\s*(stand|cover|brush|mat|press|basket|cleaner|light|tool|thermometer|grate|cart)\b/i,
  /\bpatio heater|propane heater|gas heater\b/i,
  /\bdecorat|ornament|figurine|costume|replica\b/i,
  /\b(accessor(y|ies)|replacement (part|pad|filter|basket|carafe|gasket|seal))\b/i,
];
const isDropped = (text) => DROP.some((re) => re.test(text || ""));

function brandsFrom(arr) {
  return [...new Set((arr || []).map((b) => String(b || "").trim()).filter((b) => b && b.length <= 60))];
}

function fromCPSC(r) {
  const products = r.Products || [];
  const product = clip(products.map((p) => p.Name).filter(Boolean).join("; "), 200) || r.Title || "";
  const units = products.map((p) => parseUnits(p.NumberOfUnits)).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const textParts = [r.Title, r.Description, ...(r.Hazards || []), ...products.map((p) => `${p.Name} ${p.Type} ${p.Description}`), ...(r.Remedies || [])];
  const text = textParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const inj = (r.Injuries || []).join(" ");
  return {
    source: "cpsc_recall", kind: "recall", verified: true,
    srcId: String(r.RecallID), url: r.URL, date: toISO(r.RecallDate),
    brands: brandsFrom([...(r.Manufacturers || []), ...(r.Importers || [])]),
    product, categories: inV1(r.categories), sharkninja: !!r.sharkninja,
    text, hazardTypes: r.HazardTypes || [],
    injuries: { count: parseInjuryCount(r.Injuries), types: injuryTypes(inj), level: null, raw: clip(inj, 300) },
    units, dedupKey: dedupKey(r.Title, product, r.RecallDate, r.Hazards?.join(" ")),
  };
}

function fromHC(r) {
  const text = [r.title, r.issue, r.product, r.whatToDo].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return {
    source: "healthcanada_recall", kind: "recall", verified: true,
    srcId: String(r.NID), url: r.url, date: toISO(r.lastUpdated),
    brands: brandsFrom([r.product?.split(/[\s™®]/)[0]]),
    product: clip(r.product, 200), categories: inV1(r.categories), sharkninja: !!r.sharkninja,
    text, hazardTypes: r.issue ? [r.issue] : [],
    injuries: { count: null, types: injuryTypes(r.issue + " " + r.title), level: null, raw: "" },
    units: null, dedupKey: dedupKey(r.title, r.product, r.lastUpdated, r.issue),
  };
}

function fromEU(r) {
  const text = [r.product, r.name, r.danger, r.description, r.riskType, r.measures].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return {
    source: "eu_safetygate", kind: "alert", verified: true,
    srcId: String(r.caseNumber || "").replace(/\W+/g, "-"), url: r.url, date: toISO(r.reportDate, "dmy"),
    brands: brandsFrom([r.brand]), product: clip([r.product, r.name].filter(Boolean).join(" — "), 200),
    categories: inV1(r.categories), sharkninja: !!r.sharkninja,
    text, hazardTypes: r.riskType ? r.riskType.split(/,\s*/) : [],
    injuries: { count: null, types: injuryTypes(r.riskType + " " + r.danger), level: null, raw: "" },
    units: null, dedupKey: dedupKey(r.brand, r.product, r.reportDate, r.danger),
  };
}

function fromSP(r) {
  const text = [r.productDescription, r.incidentDescription].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const level = severityToInjury(r.victimSeverity);
  return {
    source: "saferproducts_incident", kind: "incident", verified: false,
    srcId: String(r.reportNo), url: `https://www.saferproducts.gov/PublicSearch/Detail?reportId=${encodeURIComponent(r.reportNo)}`,
    date: toISO(r.reportDate), brands: brandsFrom([r.brand, r.manufacturer]),
    product: clip([r.productDescription?.split(/[\r\n.]/)[0], r.productType].filter(Boolean).join(" — "), 200),
    categories: inV1(r.categories), sharkninja: !!r.sharkninja,
    text, hazardTypes: [],
    injuries: { count: level === "none" ? 0 : 1, types: injuryTypes(r.incidentDescription), level, raw: clip(r.victimSeverity, 120) },
    units: null, dedupKey: null, // incidents are not deduped against recalls
  };
}

function dedupKey(...parts) {
  const s = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  // brand+hazard-ish signature + year, coarse on purpose to catch joint recalls
  const words = s.split(" ").filter((w) => w.length > 3).slice(0, 12).join(" ");
  return words ? sha256(words).slice(0, 16) : null;
}

const SOURCES = [
  ["cpsc/cpsc-recalls-appliances.json", fromCPSC],
  ["healthcanada/hc-recalls-appliances.json", fromHC],
  ["eu-safetygate/eu-alerts-appliances.json", fromEU],
  ["saferproducts/saferproducts-incidents-appliances.json", fromSP],
];

async function main() {
  const out = [];
  const counts = {};
  let dropped = 0, outOfScope = 0;
  for (const [file, fn] of SOURCES) {
    const rows = await readJson(join(P.raw, file), []);
    let kept = 0;
    for (const r of rows) {
      const rec = fn(r);
      if (rec.categories.length === 0) { outOfScope++; continue; }
      if (isDropped(`${rec.product} ${rec.text.slice(0, 200)}`)) { dropped++; continue; }
      rec.id = `${rec.source.split("_")[0]}-${rec.srcId}`.replace(/[^\w-]/g, "-");
      out.push(rec);
      kept++;
      for (const c of rec.categories) counts[c] = (counts[c] || 0) + 1;
    }
    log.info(`${file}: kept ${kept}/${rows.length}`);
  }

  // Light cross-source dedup: joint recalls (CPSC <-> HC/EU) share a coarse key.
  const seen = new Map();
  const order = { cpsc_recall: 0, eu_safetygate: 1, healthcanada_recall: 2, saferproducts_incident: 3 };
  out.sort((a, b) => (order[a.source] - order[b.source]));
  let dupes = 0;
  for (const rec of out) {
    if (!rec.dedupKey) { rec.duplicate = false; continue; }
    if (seen.has(rec.dedupKey)) { rec.duplicate = true; rec.duplicateOf = seen.get(rec.dedupKey); dupes++; }
    else { rec.duplicate = false; seen.set(rec.dedupKey, rec.id); }
  }

  // Canonicalize brands at the source. `brands_raw` keeps the originals (for debugging),
  // `brands` becomes the deduped consumer-brand list, `brands_canon` has {display, manufacturer, key}.
  for (const rec of out) {
    const canon = brandCanonicalList(rec.brands)
    rec.brands_raw = rec.brands
    rec.brands = canon.map((c) => c.display)
    rec.brands_canon = canon
    // Refresh sharkninja flag from canon display (robust to raw casing variants).
    rec.sharkninja = rec.sharkninja || canon.some((c) => c.display === "Ninja (SharkNinja)")
  }

  // Content hash drives the extract cache (so prompt-invariant reruns are free).
  // Hash input intentionally excludes brand lists so the brand canon change
  // alone does NOT invalidate the extract cache.
  for (const rec of out) rec.hash = sha256(`${rec.id}|${rec.categories.join(",")}|${rec.text}`);

  await writeJson(P.records, out, { pretty: false });
  log.info(`wrote ${out.length} records -> ${P.records}`);
  log.info(`out-of-scope dropped=${outOfScope} false-positive dropped=${dropped} duplicates flagged=${dupes}`);
  log.info("per category (incl. multi-category):", JSON.stringify(counts));
  const byKind = out.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
  log.info("by kind:", JSON.stringify(byKind));
}
main().catch((e) => { log.err(e); process.exit(1); });
