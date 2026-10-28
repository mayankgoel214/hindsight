/* search-core unit tests: validateSearch, topK correctness, rate-limit
   fail-closed semantics, embed error handling. Uses a mocked global fetch.
*/
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import {
  validateSearch, topK, normalize, embedQuery,
  LIMITS, cacheGet, cacheSet, cacheClear, queryCacheKey,
} from "../api/_lib/search-core.js"

test("validateSearch: rejects missing q", () => {
  assert.ok(validateSearch(null))
  assert.ok(validateSearch({}))
  assert.ok(validateSearch({ q: "" }))
  assert.ok(validateSearch({ q: "  " }))
})

test("validateSearch: respects min/max length", () => {
  assert.ok(validateSearch({ q: "a" })) // < 3
  assert.equal(validateSearch({ q: "abc" }), null)
  assert.ok(validateSearch({ q: "x".repeat(LIMITS.qMax + 1) }))
})

test("validateSearch: k must be 1..200", () => {
  assert.equal(validateSearch({ q: "abc", k: 1 }), null)
  assert.equal(validateSearch({ q: "abc", k: 200 }), null)
  assert.ok(validateSearch({ q: "abc", k: 0 }))
  assert.ok(validateSearch({ q: "abc", k: 201 }))
  assert.ok(validateSearch({ q: "abc", k: "nope" }))
})

test("validateSearch: non-object body rejected", () => {
  assert.ok(validateSearch("string"))
  assert.ok(validateSearch(123))
})

test("topK: picks the correct nearest vectors by dot product", () => {
  // Build 4 int8 'vectors' of dim 2. We'll craft a known similarity ordering.
  // Query = (1, 0). Expected order of similarity: v0 (1,0), v1 (0.9, 0.4),
  // v2 (0, 1), v3 (-1, 0).
  const dims = 2
  const count = 4
  const scale = 1 / 127
  // Build int8 vectors (approximations of the above after L2 normalize).
  const int8 = new Int8Array([
    127, 0,            // v0
    114, 51,           // v1 ≈ (0.898, 0.401)
    0, 127,            // v2
    -127, 0,           // v3
  ])
  const query = normalize([1, 0])
  const hits = topK({ queryVec: query, vecs: int8, dims, scale, k: 3, count })
  assert.equal(hits.length, 3)
  assert.deepEqual(hits.map((h) => h.i), [0, 1, 2])
  // v0's score should be close to 1
  assert.ok(hits[0].score > 0.99 && hits[0].score <= 1.001)
  // v2 should be ~0
  assert.ok(Math.abs(hits[2].score) < 0.05)
})

test("topK: k larger than count returns count rows", () => {
  const int8 = new Int8Array([127, 0, 0, 127])
  const query = normalize([1, 0])
  const hits = topK({ queryVec: query, vecs: int8, dims: 2, scale: 1 / 127, k: 10, count: 2 })
  assert.equal(hits.length, 2)
})

test("embedQuery: throws on non-ok HTTP status with status field", async () => {
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: false, status: 429,
    json: async () => ({ error: { status: "RESOURCE_EXHAUSTED" } }),
  })
  try {
    await assert.rejects(
      () => embedQuery({ apiKey: "x", text: "hi" }),
      (e) => e.status === 429
    )
  } finally { global.fetch = origFetch }
})

test("embedQuery: normalizes the returned vector", async () => {
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ embedding: { values: [3, 4] } }), // L2 = 5 → (0.6, 0.8)
  })
  try {
    const v = await embedQuery({ apiKey: "x", text: "hi", dims: 2 })
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6)
    assert.ok(Math.abs(v[1] - 0.8) < 1e-6)
  } finally { global.fetch = origFetch }
})

test("query cache: set / get / expire", () => {
  cacheClear()
  const k = queryCacheKey("Hello World")
  const k2 = queryCacheKey("hello world  ") // same after normalization
  assert.equal(k, k2, "cache key normalizes whitespace + case")
  cacheSet(k, { results: [1, 2, 3] }, 1000)
  assert.deepEqual(cacheGet(k).results, [1, 2, 3])
  cacheSet(k, { results: [1] }, 1)
  // Wait > 1ms via a sync busy-nothing: use Date math.
  const t = Date.now() + 5
  while (Date.now() < t) {} // short
  assert.equal(cacheGet(k), null)
})

test("rate-limit fail-closed path: redis without env throws, caller handles", async () => {
  const { redis } = await import("../api/_lib/search-core.js")
  const prevU = process.env.UPSTASH_REDIS_REST_URL
  const prevT = process.env.UPSTASH_REDIS_REST_TOKEN
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  try {
    await assert.rejects(() => redis([["PING"]]), /not configured/)
  } finally {
    if (prevU != null) process.env.UPSTASH_REDIS_REST_URL = prevU
    if (prevT != null) process.env.UPSTASH_REDIS_REST_TOKEN = prevT
  }
})
