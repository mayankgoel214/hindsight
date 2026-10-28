/* Shared helpers: paths, IO, hashing, parsing, logging. No npm deps. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const P = {
  raw: join(ROOT, "data", "raw"),
  records: join(ROOT, "data", "records.json"),
  cache: join(ROOT, "data", "cache"),
  eval: join(ROOT, "data", "eval"),
  pub: join(ROOT, "public", "data"),
};

export async function ensureDir(d) { await mkdir(d, { recursive: true }); }
export async function readJson(p, fallback = undefined) {
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(p, obj, { pretty = false } = {}) {
  await ensureDir(dirname(p));
  await writeFile(p, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
}
export function exists(p) { return existsSync(p); }
export async function listDir(d) { try { return await readdir(d); } catch { return []; } }

export const sha256 = (s) => createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s)).digest("hex");

/* ── Parsers ─────────────────────────────────────────────────────────── */

// "About 1,846,400 (In addition ...)" -> 1846400 ; "About 100" -> 100
export function parseUnits(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/\d{2,}/);
  return m ? Number(m[0]) : null;
}

// m/d/yyyy or d/m/yyyy or yyyy-mm-dd -> ISO yyyy-mm-dd (best effort).
export function toISO(s, order = "mdy") {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = m[3];
    let mo, d;
    if (order === "dmy") { d = a; mo = b; } else { mo = a; d = b; }
    if (mo > 12) { const t = mo; mo = d; d = t; } // swap if impossible
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/(\d{4})/);
  return m ? `${m[1]}-01-01` : null;
}
export const yearOf = (iso) => (iso && /^\d{4}/.test(iso) ? +iso.slice(0, 4) : null);

// Pull an injury count out of free text: "106 reports of burn injuries" -> 106
export function parseInjuryCount(texts) {
  const t = (Array.isArray(texts) ? texts.join(" ") : String(texts || "")).toLowerCase();
  if (/none reported|no (injur|incident)/.test(t)) return 0;
  const m = t.match(/(\d[\d,]*)\s+(?:reports?|injur|incident|consumers?|people)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const INJURY_TERMS = {
  burn: /\bburn|scald|thermal/i,
  laceration: /\blacerat|\bcut\b|sever|amputat|\bcuts\b|blade/i,
  fire: /\bfire|flame|ignit|combust/i,
  shock: /\bshock|electrocut|electric(al)? shock/i,
  "choking/ingestion": /chok|ingest|swallow|plastic.*food|foreign (object|material)/i,
  impact: /\bimpact|struck|projectil|eject|flying|hit\b/i,
};
export function injuryTypes(text) {
  const out = [];
  for (const [k, re] of Object.entries(INJURY_TERMS)) if (re.test(text || "")) out.push(k);
  return out;
}

// SaferProducts victimSeverity -> injury level enum.
export function severityToInjury(v) {
  const s = String(v || "").toLowerCase();
  if (/death|fatal/.test(s)) return "serious";
  if (/hospital|emergency|medical profession|requiring medical/.test(s)) return "medical";
  if (/first aid|injury/.test(s)) return "minor";
  return "none";
}

/* ── Logging ─────────────────────────────────────────────────────────── */
export function logger(tag) {
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  return {
    info: (...a) => console.log(`[${tag} ${el()}]`, ...a),
    warn: (...a) => console.warn(`[${tag} ${el()}] WARN`, ...a),
    err: (...a) => console.error(`[${tag} ${el()}] ERROR`, ...a),
  };
}

export const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };
export function requireKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) { console.error("GEMINI_API_KEY missing. Run with: node --env-file=../Portfolio/.env.local scripts/<step>.mjs"); process.exit(1); }
  return k;
}
