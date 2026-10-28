#!/usr/bin/env node
/* Hindsight dev server — no Vercel login required.
   Serves public/ at / and routes /api/<name> through api/<name>.js's
   default handler (Vercel-style req/res). Reads env from Portfolio.

   Run: node --env-file=../Portfolio/.env.local scripts/dev-server.mjs
*/
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const ROOT = resolve(HERE, "..")
const PUBLIC = join(ROOT, "public")
const API = join(ROOT, "api")
const PORT = Number(process.env.PORT || 3000)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
}

async function readJsonBody(req, limit = 1_000_000) {
  return new Promise((ok, bad) => {
    let n = 0
    const chunks = []
    req.on("data", (c) => {
      n += c.length
      if (n > limit) { bad(new Error("body too large")); req.destroy() }
      else chunks.push(c)
    })
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8")
      if (!s) return ok(null)
      try { ok(JSON.parse(s)) } catch { ok(s) }
    })
    req.on("error", bad)
  })
}

// Vercel-style res shim.
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => {
    if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8")
    res.end(JSON.stringify(obj))
    return res
  }
  return res
}

async function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname)
  if (p === "/") p = "/index.html"
  const full = normalize(join(PUBLIC, p))
  if (!full.startsWith(PUBLIC)) { res.statusCode = 403; return res.end("forbidden") }
  try {
    const st = await stat(full)
    if (st.isDirectory()) {
      return serveStatic(req, res, p.replace(/\/?$/, "/index.html"))
    }
    const buf = await readFile(full)
    const type = MIME[extname(full)] || "application/octet-stream"
    res.setHeader("content-type", type)
    res.setHeader("cache-control", "no-store")
    res.end(buf)
  } catch {
    res.statusCode = 404
    res.setHeader("content-type", "text/plain; charset=utf-8")
    res.end("not found")
  }
}

async function serveApi(req, res, pathname) {
  // /api/<name>[?...]
  const name = pathname.replace(/^\/api\//, "").replace(/\/+$/, "")
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) { res.statusCode = 404; return res.end("not found") }
  const file = join(API, `${name}.js`)
  let mod
  try { mod = await import(`file://${file}?t=${Date.now()}`) }
  catch (e) {
    res.statusCode = 404
    res.setHeader("content-type", "text/plain; charset=utf-8")
    return res.end(`no handler for /api/${name}: ${e.message}`)
  }
  const handler = mod.default
  if (typeof handler !== "function") { res.statusCode = 500; return res.end("no default export") }
  if (!req.body && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
    try { req.body = await readJsonBody(req) }
    catch { res.statusCode = 413; return res.end("body too large") }
  }
  wrapRes(res)
  try { await handler(req, res) }
  catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `handler threw: ${e.message}` })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname.startsWith("/api/")) return serveApi(req, res, url.pathname)
  return serveStatic(req, res, url.pathname)
})

server.listen(PORT, () => {
  console.log(`[hindsight dev] http://localhost:${PORT}`)
  console.log(`[hindsight dev] env: GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? "set" : "MISSING"}, UPSTASH=${process.env.UPSTASH_REDIS_REST_URL ? "set" : "missing (dev-allowed)"}`)
})
