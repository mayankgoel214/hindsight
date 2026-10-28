/* POST /api/search — embed the query with the same Gemini model + dims used
   to build vectors.bin, run a dot-product search, return top-K ids + scores.
   Rate-limited (Upstash, prefix hindsight:). Fail closed in production;
   in local dev (no Upstash env) a console warning is printed and the request
   is allowed through. The Gemini key is never printed or returned.
*/
import {
  loadIndex, embedQuery, topK, validateSearch, LIMITS,
  checkLimits, clientIp, clean, queryCacheKey, cacheGet, cacheSet,
} from "./_lib/search-core.js"

export const config = { maxDuration: 20 }

// Allowed cross-origin callers. Same-origin requests don't need CORS at all.
const CORS_ALLOW = new Set([
  "https://hindsight.mayank-goel.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
])

function cors(req, res) {
  const origin = String(req.headers?.origin || "")
  if (origin && CORS_ALLOW.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Vary", "Origin")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "content-type")
  res.setHeader("Cache-Control", "no-store")
}

// Hard cap on request body size. Query is bounded (160 chars + k + wrappers);
// 4 KiB is comfortably more than a well-formed request and immediately rules
// out anyone trying to shove bulk through this endpoint.
const MAX_BODY = 4096

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

export default async function handler(req, res) {
  cors(req, res)
  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" })

  // Reject outsized bodies before we parse / before any downstream work.
  const cl = Number(req.headers?.["content-length"])
  if (Number.isFinite(cl) && cl > MAX_BODY) return res.status(413).json({ error: "payload too large" })

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body
  const invalid = validateSearch(body)
  if (invalid) return res.status(400).json({ error: invalid })

  const q = body.q.trim()
  const k = body.k == null ? LIMITS.topK : Number(body.k)

  // Rate limit (prefix hindsight:). Fail closed in prod, warn-and-allow in dev.
  const haveUpstash = clean(process.env.UPSTASH_REDIS_REST_URL) && clean(process.env.UPSTASH_REDIS_REST_TOKEN)
  const isProd = (process.env.VERCEL_ENV || process.env.NODE_ENV) === "production" || process.env.VERCEL_ENV === "preview"
  let left = null
  if (haveUpstash) {
    try {
      const limit = await checkLimits(clientIp(req))
      if (!limit.ok) return res.status(200).json({ fallback: true, reason: limit.reason })
      left = limit.left
    } catch {
      // Fail closed in production.
      if (isProd) return res.status(200).json({ fallback: true, reason: "unavailable" })
      console.warn("[hindsight/search] rate limiter unavailable; allowing (dev)")
    }
  } else if (isProd) {
    return res.status(200).json({ fallback: true, reason: "unavailable" })
  } else {
    console.warn("[hindsight/search] UPSTASH env missing; allowing (dev)")
  }

  const apiKey = clean(process.env.GEMINI_API_KEY)
  if (!apiKey) return res.status(200).json({ fallback: true, reason: "unavailable" })

  // Query cache (per lambda instance). Keyed by normalized text AND k so a
  // request for 200 results doesn't get a cached 5-result response (or vice versa).
  const ck = queryCacheKey(q, k)
  const cached = cacheGet(ck)
  if (cached) {
    return res.status(200).json({ ...cached, cached: true, left })
  }

  let qvec
  try {
    qvec = await embedQuery({ apiKey, text: q })
  } catch (e) {
    const quota = e.status === 429 || e.status === 403
    return res.status(200).json({ fallback: true, reason: quota ? "quota" : "model_error" })
  }

  const idx = await loadIndex()
  if (qvec.length !== idx.dims) {
    // Log the specifics server-side (via console) but return a generic error
    // so a probing caller can't learn the index's internal dimension.
    console.error(`[hindsight/search] dim mismatch qvec=${qvec.length} idx=${idx.dims}`)
    return res.status(500).json({ error: "internal error" })
  }
  const hits = topK({
    queryVec: qvec, vecs: idx.vecs, dims: idx.dims, scale: idx.scale,
    k: Math.min(k, LIMITS.topK), count: idx.meta.count,
  })
  // Return record ids + scores. Client already has meta.json so it can
  // apply filters, group and render.
  const results = hits.map(({ i, score }) => ({ id: idx.meta.records[i].id, score: round(score) }))
  const payload = { q, model: idx.meta.model, dims: idx.dims, results }
  cacheSet(ck, payload)
  return res.status(200).json({ ...payload, left })
}

function round(x) { return Math.round(x * 10000) / 10000 }
