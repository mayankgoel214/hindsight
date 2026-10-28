# Hindsight: spec (v1)

**One line:** type a product concept or part, get every similar real-world failure across all brands, grouped by failure mode, as DFMEA-ready rows with a quoted source on every claim.

**User:** a Ninja NPD mechanical engineer (Grace Sperling's team, "Motorized/Treats" and "Ninja Heated"). Not an AI user. Works in Excel/SharePoint DFMEAs, gates P0 → P2 → DVT → TRA, tests to IEC/UL 60335.
Evidence for every requirement: `~/projects/Portfolio/docs/project-a-research.md`.

## Scope v1 (Ninja categories only)
pressure & multi-cookers · air fryers (incl. toaster-oven/air-fryer combos) · blenders & food processors (incl. portable) · ice cream / frozen drink makers · coffee & espresso · kettles · countertop ovens & toasters · grills (electric, pellet, indoor; skip propane patio heaters).
Out of v1: vacuums, hair, fans/heaters, power tools, e-bikes.

## Data (already downloaded, see data/README.md)
CPSC recalls (verified, regulator) · Health Canada recalls · EU Safety Gate · SaferProducts.gov incident reports (UNVERIFIED consumer claims, always labeled so).

## Pipeline (scripts/, Node ESM, no npm deps, Gemini over REST, key via `--env-file=../Portfolio/.env.local`, never print the key)
1. **normalize** → `data/records.json`: id, source, kind (recall | incident | alert), verified (bool), date, brands[], product, category (v1 list), text (hazard + description + narrative), injuries {count, types}, units, url.
2. **extract** (LLM, structured output, cached by record hash so reruns are free) → per record: component, failure_mode (from a per-category taxonomy, or "other: …"), cause, effect, hazard_type (burn, laceration, fire, shock, choking/ingestion, impact, other), injury (none/minor/medical/serious), `quote` = exact span from the record text proving the failure mode. Verify quote is in the text (reuse the exact/near/unsupported logic from `~/projects/Portfolio/api/_lib/pulse-core.js`); drop unsupported.
3. **embed** each record (Gemini embedding model, reduced dimensions, int8) → `public/data/vectors.bin` + `public/data/meta.json`.
4. **patterns** → per category × failure mode: counts by kind, injuries, years, brands, example records, suggested mitigation / verification test (LLM, grounded only in the cited records, number-checked), likely standard (IEC/UL 60335-2-x part, phrased "check against", never "complies").
5. **evaluate** → 60 hand-checkable records labeled for failure mode + 15 queries with expected matches. Report extraction accuracy, quote support rate, retrieval hit rate. Shown in the app.

## App (static HTML + Vercel Node functions, same pattern as the Feedback Engine)
- **Search:** one box ("glass air fryer basket", "pressure lid interlock", "blender blade assembly"). Server embeds the query; similarity search over vectors; filters: category, source, verified only, years, brand.
- **Results:** grouped by failure mode, ordered by worst injury, each group shows counts (recalls / unverified reports), years, brands, and 2–3 quoted records with links.
- **DFMEA rows:** Function · Failure mode · Cause · Effect/Hazard · Severity hint · Evidence · Suggested verification · Source. Copy and Excel/CSV export.
- **Design-review checklist:** by gate (P0, P2, DVT, TRA): "Has the design addressed X? Seen in N recalls, M injuries."
- **Category pages:** precomputed risk profile per v1 category.
- **Accuracy page.**
- **Own-brand toggle:** SharkNinja records shown in the same neutral format as every other brand, never highlighted.
- **"Bring your own data" note:** the schema accepts FMEAs, test results, field returns later.
- Rules: every claim links to a record; "no matching record" instead of guessing; rate-limited live endpoint (Upstash, prefix `hindsight:`), fail closed; CONCEPT tag + "not affiliated with SharkNinja".
- Design: clean, engineering-tool feel (dense tables, not marketing). Fast on a laptop; usable on a phone.

## Ship
Own GitHub repo `hindsight`, README for a stranger, tests (`npm test`), /safety-check, Vercel project, `hindsight.mayank-goel.com`, 45–60 s demo video.
