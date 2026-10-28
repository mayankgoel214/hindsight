/* Hindsight search core — shared by api/search.js and the dev server.
   Node-only. No npm deps. Loads the int8 vectors + meta.json once per
   process; `embedQuery` calls Gemini over REST. Nothing here is deployed
   as a route (api/_lib/* starts with an underscore).
*/
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const DATA_DIR = join(HERE, "..", "..", "public", "data")

// Mirror scripts/lib/gemini.mjs: same model + dims so vectors align.
export const EMBED_MODEL = process.env.HINDSIGHT_EMBED_MODEL || "gemini-embedding-2"
export const EMBED_DIMS = Number(process.env.HINDSIGHT_EMBED_DIMS || 256)
const BASE = "https://generativelanguage.googleapis.com/v1beta/models"

const clean = (v) => (v || "").replace(/^"|"$/g, "").trim()

export const LIMITS = { qMin: 3, qMax: 160, topK: 200 }

let indexPromise = null
export function loadIndex() {
  if (!indexPromise) indexPromise = (async () => {
    const [metaBuf, vecBuf] = await Promise.all([
      readFile(join(DATA_DIR, "meta.json"), "utf8"),
      readFile(join(DATA_DIR, "vectors.bin")),
    ])
    const meta = JSON.parse(metaBuf)
    const dims = meta.dims || EMBED_DIMS
    const vecs = new Int8Array(vecBuf.buffer, vecBuf.byteOffset, vecBuf.byteLength)
    if (vecs.length !== meta.count * dims) {
      throw new Error(`vectors.bin size ${vecs.length} != count ${meta.count} * dims ${dims}`)
    }
    return { meta, vecs, dims, scale: meta.scale }
  })()
  return indexPromise
}

export function normalize(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export async function embedQuery({ apiKey, text, dims = EMBED_DIMS, model = EMBED_MODEL, timeoutMs = 15000 }) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${BASE}/${encodeURIComponent(model)}:embedContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: dims,
        taskType: "RETRIEVAL_QUERY",
      }),
      signal: ctrl.signal,
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const err = new Error(`embed ${r.status}`)
      err.status = r.status
      throw err
    }
    return normalize(j.embedding?.values || [])
  } finally {
    clearTimeout(t)
  }
}

/** Top-K dot-product search against int8 vectors. Returns [{i, score}]. */
export function topK({ queryVec, vecs, dims, scale, k = LIMITS.topK, count }) {
  // score = sum(q[j] * (int8[j] * scale)) = scale * sum(q[j] * int8[j])
  // q is L2-normalized float, int8 rows are L2-normalized then scaled by 1/127.
  // So score is cosine similarity in [-1, 1] (approximately).
  const scores = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const off = i * dims
    let s = 0
    for (let j = 0; j < dims; j++) s += queryVec[j] * vecs[off + j]
    scores[i] = s * scale
  }
  // Partial sort: pick top-k by selection into a min-heap-ish array.
  const idxs = new Int32Array(count)
  for (let i = 0; i < count; i++) idxs[i] = i
  // Full sort is fine for 5-10k; simpler and plenty fast.
  const arr = Array.from(idxs).sort((a, b) => scores[b] - scores[a])
  return arr.slice(0, k).map((i) => ({ i, score: scores[i] }))
}

export function validateSearch(body) {
  if (!body || typeof body !== "object") return "Body must be JSON"
  const q = typeof body.q === "string" ? body.q.trim() : ""
  if (!q) return "q is required"
  if (q.length < LIMITS.qMin) return `q must be at least ${LIMITS.qMin} characters`
  if (q.length > LIMITS.qMax) return `q must be ≤ ${LIMITS.qMax} characters`
  const k = body.k == null ? LIMITS.topK : Number(body.k)
  if (!Number.isFinite(k) || k < 1 || k > LIMITS.topK) return `k must be 1..${LIMITS.topK}`
  return null
}

/* ── Rate limiter: same pattern as Portfolio pulse ────────────────────── */

export async function redis(commands) {
  const url = clean(process.env.UPSTASH_REDIS_REST_URL)
  const token = clean(process.env.UPSTASH_REDIS_REST_TOKEN)
  if (!url || !token) throw new Error("rate limiter not configured")
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  })
  if (!r.ok) throw new Error(`rate limiter ${r.status}`)
  return r.json()
}

const PER_IP_HOUR = Number(process.env.HINDSIGHT_PER_IP_HOUR || 30)
const GLOBAL_DAY = Number(process.env.HINDSIGHT_GLOBAL_DAY || 500)

export async function checkLimits(ip) {
  const now = new Date()
  const hour = now.toISOString().slice(0, 13)
  const day = now.toISOString().slice(0, 10)
  const who = createHash("sha256").update(`hindsight:${ip}`).digest("hex").slice(0, 24)
  const ipKey = `hindsight:rl:ip:${who}:${hour}`
  const dayKey = `hindsight:rl:day:${day}`
  const res = await redis([
    ["INCR", ipKey], ["EXPIRE", ipKey, "3600", "NX"],
    ["INCR", dayKey], ["EXPIRE", dayKey, "172800", "NX"],
  ])
  const ipCount = Number(res[0]?.result)
  const dayCount = Number(res[2]?.result)
  if (dayCount > GLOBAL_DAY) return { ok: false, reason: "daily_cap" }
  if (ipCount > PER_IP_HOUR) return { ok: false, reason: "visitor_limit" }
  return { ok: true, left: Math.max(0, PER_IP_HOUR - ipCount) }
}

export function clientIp(req) {
  const h = req.headers || {}
  const direct = h["x-vercel-forwarded-for"] || h["x-real-ip"]
  if (direct) return String(direct).split(",")[0].trim()
  const xff = String(h["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean)
  return xff.at(-1) || req.socket?.remoteAddress || "unknown"
}

export function queryCacheKey(q) {
  return createHash("sha256").update(`q:${q.trim().toLowerCase()}`).digest("hex").slice(0, 24)
}

/* ── Simple in-memory query cache (per lambda instance) ───────────────── */

const QCACHE_MAX = 128
const qcache = new Map()
export function cacheGet(k) {
  const v = qcache.get(k)
  if (!v) return null
  if (v.exp < Date.now()) { qcache.delete(k); return null }
  // LRU touch
  qcache.delete(k); qcache.set(k, v)
  return v.data
}
export function cacheSet(k, data, ttlMs = 10 * 60 * 1000) {
  if (qcache.size >= QCACHE_MAX) qcache.delete(qcache.keys().next().value)
  qcache.set(k, { data, exp: Date.now() + ttlMs })
}
export function cacheClear() { qcache.clear() }

export { clean }
