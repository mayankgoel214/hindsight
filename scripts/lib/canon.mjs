/* Canonicalization: brands + "other" failure-mode labels.
   Pure functions, no network, no AI. Static maps seeded from the observed
   variants in the data; falls back to a tokenized signature for anything new.
   Used by normalize.mjs (brands), by the fm-canonicalize script that rewrites
   meta.json labels, and by patterns.mjs when grouping.
*/

/* ── Brands ─────────────────────────────────────────────────────────── */

// Canonical display name keyed by a normalized "brand signature". The
// signature is the lowercase, punctuation-stripped first 1-3 content words.
const BRAND_DISPLAY = {
  "crock pot": "Crock-Pot",
  "crock-pot": "Crock-Pot",
  "sunbeam": "Sunbeam",
  "sunbeam products": "Sunbeam",
  "jarden consumer solutions": "Sunbeam",
  "ninja": "Ninja (SharkNinja)",
  "sharkninja": "Ninja (SharkNinja)",
  "sharkninja operating": "Ninja (SharkNinja)",
  "shark ninja": "Ninja (SharkNinja)",
  "euro-pro": "Ninja (SharkNinja)",
  "euro pro": "Ninja (SharkNinja)",
  "euro-pro operating": "Ninja (SharkNinja)",
  "mr coffee": "Mr. Coffee",
  "mr. coffee": "Mr. Coffee",
  "black and decker": "Black & Decker",
  "black decker": "Black & Decker",
  "black & decker": "Black & Decker",
  "black + decker": "Black & Decker",
  "hamilton beach": "Hamilton Beach",
  "cuisinart": "Cuisinart",
  "conair": "Cuisinart",
  "conair corporation": "Cuisinart",
  "keurig": "Keurig",
  "char broil": "Char-Broil",
  "char-broil": "Char-Broil",
  "charbroil": "Char-Broil",
  "tassimo": "Tassimo (Bosch)",
  "bosch": "Bosch",
  "tassimo bosch": "Tassimo (Bosch)",
  "tassimo / bosch": "Tassimo (Bosch)",
  "power pressure cooker": "Power XL",
  "power xl": "Power XL",
  "powerxl": "Power XL",
  "empower brands": "Power XL",
  "nuwave": "Nuwave",
  "instant pot": "Instant Pot",
  "instant brands": "Instant Pot",
  "cosori": "Cosori",
  "atekcity": "Cosori",
  "bella": "Bella",
  "sensio": "Bella",
  "farberware": "Farberware",
  "walmart stores": "Farberware",
  "aldi": "Ambiano (ALDI)",
  "ambiano": "Ambiano (ALDI)",
  "tempo usa": "Ambiano (ALDI)",
  "gourmia": "Gourmia",
  "the steelstone group": "Gourmia",
  "ibc-hearthware": "NuWave",
  "ibc hearthware": "NuWave",
  "zwilling": "Zwilling J.A. Henckels",
  "zwilling j a henckels": "Zwilling J.A. Henckels",
  "blendjet": "BlendJet",
  "ninja professional blender": "Ninja (SharkNinja)",
  "fagor": "Fagor",
  "fagor america": "Fagor",
  "mueller": "Mueller",
  "rapid medical": "Mueller",
}

// Manufacturer the consumer brand belongs to, for the secondary line.
const BRAND_MANUFACTURER = {
  "Crock-Pot": "Sunbeam Products / Newell Brands",
  "Mr. Coffee": "Newell Brands",
  "Tassimo (Bosch)": "BSH Home Appliances",
  "Ninja (SharkNinja)": "SharkNinja Operating LLC",
  "Power XL": "Empower Brands",
  "Instant Pot": "Instant Brands",
  "Cosori": "Atekcity",
  "Bella": "Sensio",
  "Farberware": "Walmart (licensee)",
  "Ambiano (ALDI)": "Tempo USA / ALDI",
  "Gourmia": "The Steelstone Group",
  "Cuisinart": "Conair Corporation",
}

const LEGAL_SUFFIX = /\b(l\.?l\.?c\.?|inc\.?|corp(?:oration)?|co\.?|ltd\.?|gmbh|operating|holdings?|aktiengesellschaft|d\.?b\.?a\.?)\b/gi
const CITY_TAIL = /,?\s*(of|,)\s+[A-Za-z .]{2,40}(?:,\s*[A-Z]{2,20})?\.?$/

function stripLegalTail(s) {
  let out = s
  // Drop "of Columbus, Georgia", "of Boston, MA.", etc.
  out = out.replace(CITY_TAIL, "")
  // Drop d/b/a tail: "Sunbeam Products, Inc. d/b/a Jarden Consumer Solutions" → "Sunbeam Products"
  out = out.replace(/\s+d\/?b\/?a\s+.*$/i, "")
  // Drop ™ ® © and legal suffixes
  out = out.replace(/[™®©]/g, "").replace(LEGAL_SUFFIX, " ")
  out = out.replace(/[,.]+/g, " ").replace(/\s+/g, " ").trim()
  return out
}

function normSig(s) {
  return stripLegalTail(String(s || "")).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

/** Return the canonical consumer brand for one raw manufacturer/brand string.
 *  { display, manufacturer, key } — key is used for dedupe & filter facet. */
export function brandCanonical(raw) {
  const rawTrim = String(raw || "").trim()
  if (!rawTrim) return { display: "", manufacturer: "", key: "" }
  const sig = normSig(rawTrim)
  if (!sig) return { display: rawTrim, manufacturer: "", key: rawTrim.toLowerCase() }

  // Try progressively shorter sigs: full, first 3, first 2, first 1 tokens.
  const toks = sig.split(" ")
  const tries = [sig, toks.slice(0, 3).join(" "), toks.slice(0, 2).join(" "), toks[0]]
  for (const t of tries) {
    if (BRAND_DISPLAY[t]) {
      const display = BRAND_DISPLAY[t]
      return { display, manufacturer: BRAND_MANUFACTURER[display] || "", key: display.toLowerCase() }
    }
  }
  // Fallback: title-case the trimmed signature, keep up to 3 words.
  const display = toks.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
  return { display, manufacturer: "", key: display.toLowerCase() }
}

/** Reduce a list of raw brand strings to deduplicated canonical entries,
 *  preserving the strongest signal. Returns [{display, manufacturer, key, raw[]}]. */
export function brandCanonicalList(rawList) {
  const out = new Map()
  for (const raw of rawList || []) {
    const c = brandCanonical(raw)
    if (!c.display) continue
    const slot = out.get(c.key) || { ...c, raw: [] }
    if (!slot.raw.includes(raw)) slot.raw.push(raw)
    out.set(c.key, slot)
  }
  return [...out.values()]
}

/* ── Failure-mode labels ────────────────────────────────────────────── */

// Explicit canonicalization map for the "other:*" clusters we see today,
// scoped per category. Values are canonical short labels (snake_case), joined
// to the category's taxonomy. Add here when a new cluster appears.
const FM_CANON = {
  pressure_multi_cooker: {
    "glass lid shatter": "glass_lid_shattering",
    "glass lid shattered": "glass_lid_shattering",
    "glass lid shattering": "glass_lid_shattering",
    "shattered glass lid": "glass_lid_shattering",
    "glass lid shattered glass": "glass_lid_shattering",
    "glass_lid_shattered": "glass_lid_shattering",
    "glass lid explosion": "glass_lid_shattering",
    "glass lid exploded": "glass_lid_shattering",
    "glass lid explosion shattering": "glass_lid_shattering",
    "non-stick coating degradation": "non_stick_coating_degradation",
    "timer knob failure unexpected turn on": "unexpected_activation",
    "fire": "overheat_scorching",
  },
  air_fryer: {
    "glass basket shattering": "glass_component_shattering",
    "glass basket shattered": "glass_component_shattering",
    "shattered glass basket": "glass_component_shattering",
  },
  blender_food_processor: {},
  ice_cream_frozen_drink: {},
  coffee_maker: {},
  kettle: {},
  oven_toaster: {},
  grill: {},
}

/** Signature for a free-text failure-mode label — merges punctuation/order
 *  variants ("glass lid shattered" ~= "shattered glass lid"). */
function fmSig(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Return the canonical failure_mode + label for one record's extract,
 *  given its category. Returns {failure_mode, failure_mode_label}. */
export function fmCanonical(category, failure_mode, failure_mode_label) {
  if (failure_mode !== "other") return { failure_mode, failure_mode_label: failure_mode_label || "" }
  const sig = fmSig(failure_mode_label)
  if (!sig) return { failure_mode: "other", failure_mode_label: "" }
  const map = FM_CANON[category] || {}
  // Exact or sorted-tokens match
  const sortedSig = sig.split(" ").slice().sort().join(" ")
  for (const [k, v] of Object.entries(map)) {
    const ks = fmSig(k)
    if (ks === sig) return { failure_mode: v, failure_mode_label: "" }
    if (ks.split(" ").slice().sort().join(" ") === sortedSig) return { failure_mode: v, failure_mode_label: "" }
  }
  // No canonical hit — keep as other but normalize the label.
  return { failure_mode: "other", failure_mode_label: sig }
}

/** Pretty display label for a failure_mode slug or "other" + raw label. */
export function fmDisplay(failure_mode, failure_mode_label) {
  if (!failure_mode) return "Unknown"
  if (failure_mode === "other") {
    const s = failure_mode_label || "other"
    return titleCase(s.replace(/^other:/, ""))
  }
  if (failure_mode.startsWith("other:")) return titleCase(failure_mode.slice(6))
  return titleCase(failure_mode.replace(/_/g, " "))
}

function titleCase(s) {
  const words = String(s || "").split(/\s+/).filter(Boolean)
  const small = new Set(["and", "or", "of", "the", "on", "in", "to", "a", "an", "for", "with"])
  return words.map((w, i) =>
    (i > 0 && small.has(w.toLowerCase()))
      ? w.toLowerCase()
      : (w[0]?.toUpperCase() || "") + w.slice(1).toLowerCase()
  ).join(" ")
}
