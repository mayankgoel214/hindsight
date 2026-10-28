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

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "content-type")
  res.setHeader("Cache-Control", "no-store")
}

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

export default async function handler(req, res) {
  cors(res)
  if (req.method === "OPTIONS") return res.status(204).end()
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" })

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

  // Query cache (per lambda instance). Keyed by normalized text only.
  const ck = queryCacheKey(q)
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
    return res.status(500).json({ error: `dim mismatch: ${qvec.length} vs ${idx.dims}` })
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
