/* /api/search handler integration test with mocked fetch (Gemini + Upstash).
   Walks the request through: validation, rate limiter, embedding, dot-product.
*/
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"

// Mock env BEFORE importing the handler.
process.env.GEMINI_API_KEY = "test-key-not-real"
process.env.UPSTASH_REDIS_REST_URL = "https://redis.example"
process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token"
process.env.HINDSIGHT_EMBED_DIMS = "256"
process.env.VERCEL_ENV = "production"

const { default: handler } = await import("../api/search.js")

function mockRes() {
  const res = {
    _status: 200, _headers: {}, _body: null,
    setHeader(k, v) { this._headers[k.toLowerCase()] = v },
    status(c) { this._status = c; return this },
    json(obj) { this._body = obj; return this },
    end() { return this },
    statusCode: 200, headersSent: false,
  }
  return res
}

function withFetch(impl, fn) {
  const prev = global.fetch
  global.fetch = impl
  return Promise.resolve(fn()).finally(() => { global.fetch = prev })
}

test("search: 400 on missing query", async () => {
  const req = { method: "POST", body: {}, headers: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._status, 400)
  assert.ok(res._body.error)
})

test("search: 405 on GET", async () => {
  const req = { method: "GET", headers: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._status, 405)
})

test("search: 204 on OPTIONS (CORS preflight)", async () => {
  const req = { method: "OPTIONS", headers: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res._status, 204)
})

test("search: rate-limit over cap returns fallback", async () => {
  await withFetch(async (url, opt) => {
    if (String(url).includes("redis.example")) {
      // Simulate ipCount under cap but dayCount > GLOBAL_DAY
      return { ok: true, json: async () => ([{ result: 1 }, { result: 1 }, { result: 99999 }, { result: 1 }]) }
    }
    throw new Error("unexpected fetch " + url)
  }, async () => {
    const req = { method: "POST", body: { q: "pressure cooker lid" }, headers: { "x-forwarded-for": "1.2.3.4" } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._status, 200)
    assert.equal(res._body.fallback, true)
    assert.equal(res._body.reason, "daily_cap")
  })
})

test("search: rate-limiter throws → fallback (fail closed in prod)", async () => {
  await withFetch(async (url) => {
    if (String(url).includes("redis.example")) return { ok: false, status: 500, json: async () => ({}) }
    throw new Error("unexpected")
  }, async () => {
    const req = { method: "POST", body: { q: "pressure cooker lid" }, headers: { "x-forwarded-for": "1.2.3.4" } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._body.fallback, true)
    assert.equal(res._body.reason, "unavailable")
  })
})

test("search: Gemini quota (429) returns fallback with reason=quota", async () => {
  // Rebuild cache keys: use a unique query so query-cache miss.
  await withFetch(async (url) => {
    if (String(url).includes("redis.example")) {
      return { ok: true, json: async () => ([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]) }
    }
    if (String(url).includes("embedContent")) {
      return { ok: false, status: 429, json: async () => ({ error: { status: "RESOURCE_EXHAUSTED" } }) }
    }
    throw new Error("unexpected " + url)
  }, async () => {
    const req = { method: "POST", body: { q: "quota-path unique-" + Date.now() }, headers: { "x-forwarded-for": "9.9.9.9" } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._body.fallback, true)
    assert.equal(res._body.reason, "quota")
  })
})

test("search: happy path returns {results, model, dims}", async () => {
  await withFetch(async (url) => {
    if (String(url).includes("redis.example")) {
      return { ok: true, json: async () => ([{ result: 1 }, { result: 1 }, { result: 1 }, { result: 1 }]) }
    }
    if (String(url).includes("embedContent")) {
      // Return a 256-dim vector. The index returns top-K ids; we don't care which.
      return { ok: true, json: async () => ({ embedding: { values: new Array(256).fill(1 / Math.sqrt(256)) } }) }
    }
    throw new Error("unexpected " + url)
  }, async () => {
    const req = { method: "POST", body: { q: "happy-path unique-" + Date.now(), k: 5 }, headers: { "x-forwarded-for": "5.6.7.8" } }
    const res = mockRes()
    await handler(req, res)
    assert.equal(res._status, 200)
    assert.ok(Array.isArray(res._body.results), "results is an array")
    assert.ok(res._body.results.length > 0 && res._body.results.length <= 5)
    assert.ok(res._body.dims === 256)
    for (const r of res._body.results) {
      assert.ok(typeof r.id === "string")
      assert.ok(typeof r.score === "number")
    }
  })
})
