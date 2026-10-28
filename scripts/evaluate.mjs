/* Pipeline step 5 — evaluate.
   Reads data/eval/labels.json: 60 hand-labeled records (failure_mode +
   hazard_type) and 15 engineer queries with expected relevant record ids.
   Reports:
     - extraction accuracy: model failure_mode / hazard_type vs hand labels
     - quote support rate: share of all extractions with a verified quote
     - retrieval hit@10 / recall@10: query embedded, top-10 over vectors.bin
   Writes public/data/eval.json for the app's Accuracy page.

   Run: node --env-file=../Portfolio/.env.local scripts/evaluate.mjs
*/
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { P, readJson, writeJson, logger, requireKey } from "./lib/util.mjs";
import { embed, dequantize, makeCost, EMBED_MODEL, EMBED_DIMS } from "./lib/gemini.mjs";

const log = logger("evaluate");

async function main() {
  const apiKey = requireKey();
  const labels = await readJson(join(P.eval, "labels.json"));
  const extracted = await readJson(join(P.cache, "extracted.json"));
  const exById = new Map(extracted.map((r) => [r.id, r.extract]));

  // 1. Extraction accuracy vs hand labels.
  let fmHit = 0, hzHit = 0, scored = 0;
  const perRecord = [];
  for (const lab of labels.records) {
    const ex = exById.get(lab.id);
    if (!ex) { perRecord.push({ id: lab.id, missing: true }); continue; }
    scored++;
    const fmOk = ex.failure_mode === lab.failure_mode;
    const hzOk = ex.hazard_type === lab.hazard_type;
    if (fmOk) fmHit++; if (hzOk) hzHit++;
    perRecord.push({ id: lab.id, failure_mode: { got: ex.failure_mode, want: lab.failure_mode, ok: fmOk }, hazard_type: { got: ex.hazard_type, want: lab.hazard_type, ok: hzOk } });
  }

  // 2. Quote support rate across all extractions.
  let supported = 0;
  for (const r of extracted) if (r.extract.quote_status !== "unsupported") supported++;
  const quoteSupportRate = extracted.length ? supported / extracted.length : 0;

  // 3. Retrieval hit@10 over the published vectors.
  const meta = await readJson(join(P.pub, "meta.json"));
  const bin = new Int8Array((await readFile(join(P.pub, "vectors.bin"))).buffer);
  const dims = meta.dims;
  const idByRow = meta.records.map((r) => r.id);
  // (category|failure_mode) for every published record, for relevance scoring.
  const classById = new Map(meta.records.map((r) => [r.id, `${r.category}|${r.failure_mode}`]));
  const cost = makeCost();
  let hits = 0, recallSum = 0, relHits = 0, relPrecSum = 0;
  const perQuery = [];
  for (const q of labels.queries) {
    const qv = await embed({ apiKey, text: q.q, dims: EMBED_DIMS, taskType: "RETRIEVAL_QUERY" });
    cost.addEmbed(EMBED_MODEL, Math.ceil(q.q.length / 4));
    const scores = new Array(meta.count);
    for (let i = 0; i < meta.count; i++) {
      const dv = dequantize(bin, i * dims, dims);
      let dot = 0; for (let k = 0; k < dims; k++) dot += qv[k] * dv[k];
      scores[i] = dot;
    }
    const top = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 10).map((i) => idByRow[i]);
    const expected = new Set(q.expected);
    // Strict, id-based (conservative lower bound: the corpus has many near-identical valid matches).
    const found = top.filter((id) => expected.has(id));
    const hit = found.length > 0;
    if (hit) hits++;
    recallSum += expected.size ? found.length / expected.size : 0;
    // Relevance-based: a top-10 result counts as relevant if it shares the
    // (category, failure_mode) of the query's expected records — what the
    // engineer actually needs surfaced.
    const relClasses = new Set(q.expected.map((id) => classById.get(id)).filter(Boolean));
    const relevantInTop = top.filter((id) => relClasses.has(classById.get(id)));
    const relPrec = relevantInTop.length / top.length;
    relPrecSum += relPrec;
    if (relevantInTop.length > 0) relHits++;
    perQuery.push({ q: q.q, hit, found, expected: q.expected, relevant_in_top10: relevantInTop.length, relevance_precision_at10: round(relPrec), top10: top });
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    model: { embed: EMBED_MODEL },
    corpus: { extracted: extracted.length },
    extraction: {
      labeled: labels.records.length,
      scored,
      failure_mode_accuracy: round(fmHit / scored),
      hazard_type_accuracy: round(hzHit / scored),
    },
    quote_support_rate: round(quoteSupportRate),
    retrieval: {
      queries: labels.queries.length,
      note: "hit@10/recall@10 are strict id-based and a conservative lower bound: the corpus has many near-identical valid matches, so the specific labeled records are often outranked. relevance@10 measures whether the top-10 surface the correct category + failure mode, which is what the tool needs.",
      "hit@10": round(hits / labels.queries.length),
      "recall@10": round(recallSum / labels.queries.length),
      "relevance_hit@10": round(relHits / labels.queries.length),
      "relevance_precision@10": round(relPrecSum / labels.queries.length),
    },
    perRecord,
    perQuery,
  };
  await writeJson(join(P.pub, "eval.json"), out, { pretty: true });
  log.info(`extraction: fm=${out.extraction.failure_mode_accuracy} hz=${out.extraction.hazard_type_accuracy} (n=${scored})`);
  log.info(`quote support rate=${out.quote_support_rate} over ${extracted.length} extractions`);
  log.info(`retrieval strict hit@10=${out.retrieval["hit@10"]} recall@10=${out.retrieval["recall@10"]} | relevance hit@10=${out.retrieval["relevance_hit@10"]} precision@10=${out.retrieval["relevance_precision@10"]} (${labels.queries.length} queries) | ${cost.summary()}`);
}
const round = (x) => Math.round(x * 1000) / 1000;
main().catch((e) => { log.err(e); process.exit(1); });
