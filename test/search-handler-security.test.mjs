/* Security + rate-limit regression tests for /api/search. */
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.GEMINI_API_KEY = "test-key"
process.env.UPSTASH_REDIS_REST_URL = "https://redis.example"
process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token"
process.env.VERCEL_ENV = "production"

const { default: handler } = await import("../api/search.js")

function mockRes() {
  return {
    _status: 200, _headers: {}, _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v },
    status(c) { this._status = c; return this },
    json(obj) { this._body = obj; return this },
    end() { return this },
    statusCode: 200, headersSent: false,
  }
}

function withFetch(impl, fn) {
  const prev = global.fetch
  global.fetch = impl
  return Promise.resolve(fn()).finally(() => { global.fetch = prev })
}

// Security C: CORS only echoes allowed origins; others get no allow-origin header.
test("CORS: unknown Origin → no Access-Control-Allow-Origin", async () => {
  const req = { method: "OPTIONS", headers: { origin: "https://evil.example" } }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._status, 204)
  assert.equal(res._headers["access-control-allow-origin"], undefined)
})
test("CORS: allowed origin is echoed", async () => {
  const req = { method: "OPTIONS", headers: { origin: "https://hindsight.mayank-goel.com" } }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._headers["access-control-allow-origin"], "https://hindsight.mayank-goel.com")
})

// Security D: content-length > MAX_BODY (4096) → 413.
test("content-length too large → 413", async () => {
  const req = { method: "POST", headers: { "content-length": "99999" }, body: { q: "x".repeat(200) } }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._status, 413)
})

// Security E: dim mismatch returns generic error, not internals.
test("dim mismatch returns generic 'internal error' (no dims leaked)", async () => {
  await withFetch(async (url) => {
    if (String(url).includes("redis.example")) {
      return { ok: true, json: async () => ([{ result: 1 }, { result: 1 }]) }
    }
    if (String(url).includes("embedContent")) {
      // Return a short vector to force dim mismatch (index is 256-dim).
      return { ok: true, json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }) }
    }
    throw new Error("unexpected " + url)
  }, async () => {
    const req = { method: "POST", headers: { "x-forwarded-for": "1.2.3.4" }, body: { q: "dim-mismatch unique " + Date.now() } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._status, 500)
    assert.equal(res._body.error, "internal error")
    // No internals leaked
    assert.ok(!/\d/.test(res._body.error))
  })
})

// Fix 9: rate limiter checks IP first; a denied visitor never touches the
// global counter in Redis. (If IP-check denies, the second redis call must
// not fire.)
test("rate limiter: visitor over cap → global counter not INCRed", async () => {
  let incrCalls = 0; let secondPipeline = false
  await withFetch(async (url, opt) => {
    if (String(url).includes("redis.example")) {
      incrCalls++
      if (incrCalls === 1) {
        // First pipeline = per-IP. Return a count already over the cap.
        return { ok: true, json: async () => ([{ result: 999 }, { result: 1 }]) }
      }
      secondPipeline = true // we don't want this to happen
      return { ok: true, json: async () => ([{ result: 1 }, { result: 1 }]) }
    }
    throw new Error("unexpected " + url)
  }, async () => {
    const req = { method: "POST", headers: { "x-forwarded-for": "9.9.9.9" }, body: { q: "visitor-cap-check " + Date.now() } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._body.fallback, true)
    assert.equal(res._body.reason, "visitor_limit")
    assert.equal(secondPipeline, false, "global pipeline should not fire when IP is denied")
  })
})
