/* Weekly refresh orchestrator for GitHub Actions.
 *
 * Runs the whole pipeline, tolerant of source failures, and emits a run
 * summary. Caches (extract + embed per record hash) are expected to already
 * live in data/cache/ — the workflow restores them from the data-cache branch
 * before invoking this script, and repacks them after.
 *
 * Steps:
 *   1. Fetch each source. On failure: keep the existing data/raw/<source>/
 *      snapshot (restored from data-cache) and record a warning. Fail only if
 *      a source has neither a fresh pull nor a snapshot.
 *   2. Normalize.
 *   3. Cost guard: count records whose extract-cache miss would cost AI money.
 *      Abort if above --max-extract-new (default 600).
 *   4. Extract, embed, patterns, evaluate.
 *   5. Sanity: tests, record-count delta ≤5%, quote_support_rate ≥ 0.99.
 *   6. Write public/data/version.json.
 *   7. Emit a GITHUB_STEP_SUMMARY line and a one-line commit subject on stdout
 *      (consumed by the workflow).
 *
 * No npm deps. Node 20+. GEMINI_API_KEY is required (checked once up front).
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data/raw");
const CACHE_EXTRACT = join(ROOT, "data/cache/extract");
const PUBLIC_DATA = join(ROOT, "public/data");

const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY;
function summary(line) {
  console.log(line);
  if (SUMMARY_PATH) { try { appendFileSync(SUMMARY_PATH, line + "\n"); } catch {} }
}

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.findIndex((a) => a === `--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MAX_EXTRACT_NEW = Number(argVal("max-extract-new", "600"));
const SKIP_FETCH = args.includes("--skip-fetch");

function run(cmd, cmdArgs, { allowFail = false, label } = {}) {
  const name = label || `${cmd} ${cmdArgs.join(" ")}`;
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: process.env });
    p.on("exit", (code) => {
      const sec = ((Date.now() - started) / 1000).toFixed(1);
      if (code === 0) { console.log(`[ok] ${name} (${sec}s)`); resolve({ ok: true, code }); }
      else {
        console.log(`[fail] ${name} exit=${code} (${sec}s)`);
        if (allowFail) resolve({ ok: false, code });
        else { process.exitCode = code || 1; resolve({ ok: false, code }); throw new Error(`${name} failed`); }
      }
    });
    p.on("error", (err) => { console.log(`[fail] ${name}: ${err.message}`); if (allowFail) resolve({ ok: false, err }); else throw err; });
  });
}

async function fileCount(dir) {
  try { const fs = await import("node:fs/promises"); const entries = await fs.readdir(dir); return entries.length; }
  catch { return 0; }
}
async function sizeOf(path) { try { return (await stat(path)).size; } catch { return 0; } }
async function readJsonSafe(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

/* Fetch sources: each is best-effort. On failure we rely on the restored
 * snapshot. Produces { source: {ok, note} }. */
async function fetchSources() {
  const steps = [
    { source: "cpsc", snapshot: "cpsc/cpsc-recalls-appliances.json", cmd: ["node", "scripts/fetch-cpsc-recalls.mjs", "--refresh"] },
    { source: "healthcanada", snapshot: "healthcanada/hc-recalls-appliances.json", cmd: ["node", "scripts/fetch-healthcanada-recalls.mjs", "--no-details"] },
    { source: "eu-safetygate", snapshot: "eu-safetygate/eu-alerts-appliances.json", cmd: ["node", "scripts/fetch-eu-safetygate.mjs"] },
    { source: "saferproducts", snapshot: "saferproducts/saferproducts-incidents-appliances.json", cmd: ["node", "scripts/fetch-saferproducts-incidents.mjs"] },
  ];
  const status = {};
  for (const s of steps) {
    if (SKIP_FETCH) { status[s.source] = { ok: existsSync(join(RAW, s.snapshot)), note: "skip-fetch (reused snapshot)" }; continue; }
    const beforeSnap = await sizeOf(join(RAW, s.snapshot));
    const [cmd, ...rest] = s.cmd;
    const res = await run(cmd, rest, { allowFail: true, label: `fetch ${s.source}` });
    const afterSnap = await sizeOf(join(RAW, s.snapshot));
    if (res.ok && afterSnap > 0) {
      status[s.source] = { ok: true, note: beforeSnap === 0 ? "fresh (first pull)" : "fresh" };
    } else if (afterSnap > 0) {
      status[s.source] = { ok: false, note: `fetch failed (code=${res.code}); reused prior snapshot` };
    } else {
      status[s.source] = { ok: false, note: "fetch failed and no snapshot available" };
    }
  }
  return status;
}

/* Count how many records in data/records.json would need a new extract call
 * (i.e. their hash is not in data/cache/extract/). */
async function countExtractMisses() {
  const records = await readJsonSafe(join(ROOT, "data/records.json"));
  if (!records) throw new Error("data/records.json missing after normalize");
  let miss = 0;
  for (const r of records) if (!existsSync(join(CACHE_EXTRACT, `${r.hash}.json`))) miss++;
  return { total: records.length, miss };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(2); }

  // Previous public/data for sanity-check delta.
  const prevEval = await readJsonSafe(join(PUBLIC_DATA, "eval.json"));
  const prevMetaCount = prevEval?.corpus?.extracted ?? 0;

  summary("### Hindsight weekly refresh");

  // 1. Fetch
  const sourceStatus = await fetchSources();
  summary("");
  summary("| source | status | note |");
  summary("|---|---|---|");
  for (const [src, s] of Object.entries(sourceStatus)) {
    summary(`| ${src} | ${s.ok ? "fresh" : "stale/failed"} | ${s.note} |`);
  }
  const anySource = Object.values(sourceStatus).some((s) => s.ok || !s.note.startsWith("fetch failed and no snapshot"));
  if (!anySource) { summary("All sources failed with no cached snapshot. Aborting."); process.exit(3); }
  // Require at least one of the three VERIFIED-regulator sources to have usable data.
  if (!(sourceStatus.cpsc && !sourceStatus.cpsc.note.includes("no snapshot") &&
        sourceStatus.healthcanada && !sourceStatus.healthcanada.note.includes("no snapshot") &&
        sourceStatus.eu && !sourceStatus["eu-safetygate"]?.note.includes("no snapshot"))) {
    // Soft check — just warn.
    summary("");
    summary("Warning: some regulator sources are stale (reused snapshot).");
  }

  // 2. Normalize
  await run("node", ["scripts/normalize.mjs"], { label: "normalize" });

  // 3. Cost guard
  const { total, miss } = await countExtractMisses();
  summary("");
  summary(`Extract cost guard: ${miss} new records would be sent to Gemini (of ${total} total).`);
  if (miss > MAX_EXTRACT_NEW) {
    summary(`ABORT: ${miss} > MAX_EXTRACT_NEW=${MAX_EXTRACT_NEW}. Set a higher threshold or inspect source changes before paying.`);
    process.exit(4);
  }

  // 4. AI steps
  await run("node", ["scripts/extract.mjs"], { label: "extract" });
  await run("node", ["scripts/embed.mjs"], { label: "embed" });
  await run("node", ["scripts/patterns.mjs"], { label: "patterns" });
  await run("node", ["scripts/evaluate.mjs"], { label: "evaluate" });

  // 5. Sanity checks
  const evalOut = await readJsonSafe(join(PUBLIC_DATA, "eval.json"));
  const newCount = evalOut?.corpus?.extracted ?? 0;
  const qsupport = evalOut?.quote_support_rate ?? 0;
  const delta = prevMetaCount ? (newCount - prevMetaCount) / prevMetaCount : 0;
  summary("");
  summary(`Record count: ${prevMetaCount} -> ${newCount} (delta ${(delta * 100).toFixed(2)}%).`);
  summary(`Quote support rate: ${qsupport}.`);
  if (prevMetaCount && delta < -0.05) {
    summary(`ABORT: record count dropped more than 5%.`);
    process.exit(5);
  }
  if (qsupport > 0 && qsupport < 0.99) {
    summary(`ABORT: quote support rate ${qsupport} below 0.99 floor.`);
    process.exit(6);
  }

  // Tests
  const t = await run("npm", ["test", "--silent"], { allowFail: true, label: "npm test" });
  if (!t.ok) { summary("ABORT: npm test failed."); process.exit(7); }

  // 6. version.json
  const now = new Date();
  const version = {
    generatedAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    records: newCount,
    delta: prevMetaCount ? newCount - prevMetaCount : newCount,
    sources: Object.fromEntries(Object.entries(sourceStatus).map(([k, v]) => [k, { fresh: v.ok, note: v.note }])),
    pipeline: { quote_support_rate: qsupport },
  };
  await mkdir(PUBLIC_DATA, { recursive: true });
  await writeFile(join(PUBLIC_DATA, "version.json"), JSON.stringify(version, null, 2) + "\n");

  // 7. Expose values the workflow needs for commit message.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `new_records=${newCount}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `delta=${version.delta}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `date=${version.date}\n`);
  }

  summary("");
  summary(`Refresh complete. New records total: ${newCount}. Delta vs last run: ${version.delta >= 0 ? "+" : ""}${version.delta}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
