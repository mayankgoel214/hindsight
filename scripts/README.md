# Hindsight data pipeline

Turns the raw product-safety records in `../data/raw/` into the files the app
serves from `../public/data/`. Node 20+, ESM, **no npm dependencies**. Gemini is
called over REST; the key is read from the environment, never printed or copied.

## Run

```bash
# one step at a time (key needed from step 2 on)
node scripts/normalize.mjs
node --env-file=../Portfolio/.env.local scripts/extract.mjs
node --env-file=../Portfolio/.env.local scripts/embed.mjs
node --env-file=../Portfolio/.env.local scripts/patterns.mjs
node --env-file=../Portfolio/.env.local scripts/evaluate.mjs

# or the whole thing (each sub-step supplies its own --env-file)
npm run pipeline
npm test   # node --test (quote verifier)
```

The env var is `GEMINI_API_KEY` (same name the Feedback Engine's `pulse-core.js`
reads). Models: text = `gemini-3.5-flash` (structured output, `maxOutputTokens`
8192 — thinking tokens count), embeddings = `gemini-embedding-2` at 256 dims,
L2-normalized and int8-quantized. Override with `HINDSIGHT_TEXT_MODEL`,
`HINDSIGHT_EMBED_MODEL`, `HINDSIGHT_EMBED_DIMS`.

## Steps

1. **normalize** → `data/records.json`. Maps the four sources to one shape, keeps
   only v1 categories, drops accessories / out-of-scope rows, flags joint-recall
   duplicates. Incidents are `verified:false` (unverified consumer claims).
2. **extract** → cache in `data/cache/extract/<record-hash>.json`, assembled into
   `data/cache/extracted.json`. Per record: component, failure_mode (per-category
   taxonomy in `lib/taxonomy.mjs`, or `other`), cause, effect, hazard_type,
   injury, and a **quote verified in code** (`lib/quote.mjs`, ported from
   `pulse-core.js`); unsupported quotes are dropped. Batched per category,
   concurrency ~4, retries with backoff, resumable (cached by hash). A truncated
   or unparseable batch is split and retried down to one record.
   Flags: `--pilot N --batch N --concurrency N --category C`.
3. **embed** → `public/data/vectors.bin` (row-major Int8) + `public/data/meta.json`
   (per-record fields + `dims`, `scale`). Cached per hash.
4. **patterns** → `public/data/patterns.json`. category × failure_mode groups;
   counts computed in code; mitigation/verification text is model-generated,
   grounded only in cited example records, and **every number is checked against
   the computed counts** (regenerate once, else drop). Standard hint phrased
   "check against", never "complies".
5. **evaluate** → `public/data/eval.json`. 60 hand-labeled records + 15 engineer
   queries (`data/eval/labels.json`). Reports extraction accuracy, quote support
   rate, retrieval hit@10.

## Notes

- **Incident reports are unverified consumer claims.** They keep `verified:false`
  everywhere and are never described as recalls.
- **Resumable:** every network step caches by record hash, so a dropped
  connection resumes for free on re-run.
- Cost is logged per step (prompt / output / thinking / embed tokens + a USD
  estimate). The USD rate in `lib/gemini.mjs` is a list-price estimate — verify
  against current Gemini pricing before quoting it.
