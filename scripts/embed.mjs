/* Pipeline step 3 — embed.
   Embeds every in-scope extracted record with the current Gemini embedding
   model at reduced output dimensionality, L2-normalizes, int8-quantizes, and
   writes public/data/vectors.bin (row-major Int8) + public/data/meta.json
   (per-record fields the app needs, plus dims/scale for the vectors).

   Cached per record hash in data/cache/embed/ so reruns and dropped
   connections are free/resumable.

   Run: node --env-file=../Portfolio/.env.local scripts/embed.mjs [--concurrency N]
*/
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { P, readJson, writeJson, ensureDir, exists, logger, requireKey, clip } from "./lib/util.mjs";
import { embed, makeCost, pool, quantize, EMBED_MODEL, EMBED_DIMS, QUANT_SCALE } from "./lib/gemini.mjs";
import { yearOf } from "./lib/util.mjs";
import { fmCanonical } from "./lib/canon.mjs";

const log = logger("embed");
const CACHE = join(P.cache, "embed");
let concurrency = 4;
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--concurrency") concurrency = Number(process.argv[++i]);

// The document text the record is retrieved by. Front-loads the engineer-facing
// terms (product, component, failure mode) a query like "glass air fryer basket"
// would use, then the cause/effect and a short slice of the source text.
function docText(rec) {
  const ex = rec.extract;
  const fm = ex.failure_mode === "other" ? ex.failure_mode_label : ex.failure_mode.replace(/_/g, " ");
  return [
    rec.product,
    ex.component,
    fm,
    ex.cause && ex.cause !== "unknown" ? `cause: ${ex.cause}` : "",
    ex.effect ? `effect: ${ex.effect}` : "",
    `${ex.hazard_type} hazard`,
    rec.categories.join(" "),
    clip(rec.text, 400),
  ].filter(Boolean).join(". ");
}

// Short display text for the app (meta.json), distinct from the proving quote.
function shortText(rec) {
  const ex = rec.extract;
  const fm = ex.failure_mode === "other" ? (ex.failure_mode_label || "other") : ex.failure_mode.replace(/_/g, " ");
  return clip(`${ex.component || rec.product}: ${fm}${ex.effect ? " — " + ex.effect : ""}`, 160);
}

async function main() {
  const apiKey = requireKey();
  await ensureDir(CACHE);
  await ensureDir(P.pub);
  const extracted = await readJson(join(P.cache, "extracted.json"));
  log.info(`${extracted.length} records to embed (model=${EMBED_MODEL}, dims=${EMBED_DIMS}, conc=${concurrency})`);

  const cost = makeCost();
  let done = 0, fromCache = 0;
  const vecs = await pool(extracted, concurrency, async (rec) => {
    const cf = join(CACHE, `${rec.hash}.json`);
    if (exists(cf)) { fromCache++; done++; if (done % 500 === 0) log.info(`${done}/${extracted.length} (cached ${fromCache})`); return readJson(cf); }
    const text = docText(rec);
    const v = await embed({ apiKey, text, dims: EMBED_DIMS, taskType: "RETRIEVAL_DOCUMENT" });
    cost.addEmbed(EMBED_MODEL, Math.ceil(text.length / 4)); // ~4 chars/token estimate
    await writeJson(cf, v);
    done++;
    if (done % 200 === 0 || done === extracted.length) log.info(`${done}/${extracted.length} | ${cost.summary()}`);
    return v;
  });

  // Pack int8 vectors row-major; meta row order matches vector order.
  const buf = new Int8Array(extracted.length * EMBED_DIMS);
  const meta = { model: EMBED_MODEL, dims: EMBED_DIMS, scale: QUANT_SCALE, count: extracted.length, records: [] };
  for (let i = 0; i < extracted.length; i++) {
    const q = quantize(vecs[i]);
    buf.set(q, i * EMBED_DIMS);
    const rec = extracted[i], ex = rec.extract;
    // Apply failure-mode canon so meta.json ships canonical labels
    // (the extract cache stays untouched; this is a label fixup only).
    const fc = fmCanonical(rec.categories[0], ex.failure_mode, ex.failure_mode_label);
    const brandsCanon = (rec.brands_canon || []).slice(0, 4);
    meta.records.push({
      id: rec.id,
      source: rec.source,
      kind: rec.kind,
      verified: rec.verified,
      date: rec.date,
      year: yearOf(rec.date),
      brands: (rec.brands || []).slice(0, 4),
      brands_canon: brandsCanon,
      product: clip(rec.product, 160),
      category: rec.categories[0],
      categories: rec.categories,
      sharkninja: rec.sharkninja,
      component: ex.component,
      failure_mode: fc.failure_mode,
      failure_mode_label: fc.failure_mode_label,
      cause: ex.cause,
      effect: ex.effect,
      hazard_type: ex.hazard_type,
      injury: ex.injury,
      quote: ex.quote,
      quote_status: ex.quote_status,
      url: rec.url,
      units: rec.units ?? null,
      text: shortText(rec),
    });
  }
  await writeFile(join(P.pub, "vectors.bin"), Buffer.from(buf.buffer));
  await writeJson(join(P.pub, "meta.json"), meta);
  // Split: a tiny index for first paint (filters, facets, grouping keys),
  // and the full meta.json loaded lazily on the first search.
  const index = {
    model: meta.model, dims: meta.dims, scale: meta.scale, count: meta.count,
    records: meta.records.map((r) => ({
      id: r.id, kind: r.kind, verified: r.verified, year: r.year,
      category: r.category, failure_mode: r.failure_mode, failure_mode_label: r.failure_mode_label,
      injury: r.injury, sharkninja: r.sharkninja,
      brands: (r.brands_canon || []).map((b) => b.display),
    })),
  };
  await writeJson(join(P.pub, "meta-index.json"), index);
  log.info(`wrote vectors.bin (${(buf.byteLength / 1e6).toFixed(2)} MB) + meta.json (${extracted.length} records) + meta-index.json (small)`);
  log.info(`embeddings from cache=${fromCache}, new=${extracted.length - fromCache} | ${cost.summary()}`);
}
main().catch((e) => { log.err(e); process.exit(1); });
