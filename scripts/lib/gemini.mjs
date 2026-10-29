/* Gemini over REST — generateContent (structured) + embedContent.
   Concurrency pool, retry with exponential backoff, token/cost accounting.
   Key is read from process.env by the caller (never logged here). */

export const TEXT_MODEL = process.env.HINDSIGHT_TEXT_MODEL || "gemini-3.5-flash";
export const EMBED_MODEL = process.env.HINDSIGHT_EMBED_MODEL || "gemini-embedding-2";
export const EMBED_DIMS = Number(process.env.HINDSIGHT_EMBED_DIMS || 256);

// Published list-price estimates (USD per 1M tokens). Flag: verify against
// current Gemini pricing before quoting to anyone. Thinking tokens bill as output.
export const PRICE = {
  [TEXT_MODEL]: { in: 0.30, out: 2.50 },
  [EMBED_MODEL]: { in: 0.15, out: 0 },
};

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function makeCost() {
  const c = { calls: 0, promptTok: 0, outTok: 0, thoughtTok: 0, embedTok: 0, usd: 0, byModel: {} };
  return {
    addGen(model, u) {
      c.calls++;
      const pin = u?.promptTokenCount || 0;
      const out = u?.candidatesTokenCount || 0;
      const th = u?.thoughtsTokenCount || 0;
      c.promptTok += pin; c.outTok += out; c.thoughtTok += th;
      const pr = PRICE[model] || { in: 0, out: 0 };
      const usd = (pin / 1e6) * pr.in + ((out + th) / 1e6) * pr.out;
      c.usd += usd;
      c.byModel[model] = c.byModel[model] || { calls: 0, promptTok: 0, outTok: 0, thoughtTok: 0, usd: 0 };
      Object.assign(c.byModel[model], {
        calls: c.byModel[model].calls + 1,
        promptTok: c.byModel[model].promptTok + pin,
        outTok: c.byModel[model].outTok + out,
        thoughtTok: c.byModel[model].thoughtTok + th,
        usd: c.byModel[model].usd + usd,
      });
    },
    addEmbed(model, tok, count = 1) {
      c.calls += count;
      c.embedTok += tok;
      const pr = PRICE[model] || { in: 0 };
      const usd = (tok / 1e6) * pr.in;
      c.usd += usd;
      c.byModel[model] = c.byModel[model] || { calls: 0, embedTok: 0, usd: 0 };
      c.byModel[model].calls = (c.byModel[model].calls || 0) + count;
      c.byModel[model].embedTok = (c.byModel[model].embedTok || 0) + tok;
      c.byModel[model].usd = (c.byModel[model].usd || 0) + usd;
    },
    get() { return c; },
    summary() {
      return `calls=${c.calls} prompt=${c.promptTok} out=${c.outTok} think=${c.thoughtTok} embed=${c.embedTok} ~$${c.usd.toFixed(4)}`;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** POST with retry/backoff. Returns parsed JSON body; throws on final failure. */
async function post(url, body, { apiKey, timeoutMs = 60000, tries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = [j.error?.status, j.error?.message].filter(Boolean).join(" — ") || JSON.stringify(j).slice(0, 400);
        const e = new Error(`gemini ${r.status}: ${detail}`);
        e.status = r.status;
        if (RETRYABLE.has(r.status) && attempt < tries - 1) { lastErr = e; await sleep(backoff(attempt, r)); continue; }
        throw e;
      }
      return j;
    } catch (e) {
      lastErr = e;
      const retriable = e.name === "AbortError" || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(String(e.message));
      if (retriable && attempt < tries - 1) { await sleep(backoff(attempt)); continue; }
      if (e.status && !RETRYABLE.has(e.status)) throw e;
      if (attempt >= tries - 1) throw e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}
function backoff(attempt, r) {
  const ra = r?.headers?.get?.("retry-after");
  if (ra && !Number.isNaN(+ra)) return Math.min(+ra * 1000, 30000);
  return Math.min(1000 * 2 ** attempt, 20000) + Math.floor(Math.random() * 500);
}

/** Structured generateContent. Returns { parsed, usage, finishReason, truncated }. */
export async function genJSON({ apiKey, model = TEXT_MODEL, system, userText, schema, maxOutputTokens = 8192, temperature = 0, thinkingLevel }) {
  const generationConfig = { temperature, responseMimeType: "application/json", responseSchema: schema, maxOutputTokens };
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
  const body = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig,
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const j = await post(`${BASE}/${encodeURIComponent(model)}:generateContent`, body, { apiKey });
  const cand = j.candidates?.[0];
  const finishReason = cand?.finishReason;
  const raw = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  const truncated = finishReason && finishReason !== "STOP";
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* caller handles null */ }
  return { parsed, raw, usage: j.usageMetadata || null, finishReason, truncated };
}

/** Embed one text. Returns Float32 values (L2-normalized defensively). */
export async function embed({ apiKey, model = EMBED_MODEL, text, dims = EMBED_DIMS, taskType = "RETRIEVAL_DOCUMENT" }) {
  const j = await post(`${BASE}/${encodeURIComponent(model)}:embedContent`, {
    model: `models/${model}`,
    content: { parts: [{ text }] },
    outputDimensionality: dims,
    taskType,
  }, { apiKey });
  const v = j.embedding?.values || [];
  return normalize(v);
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// int8 quantization of an L2-normalized vector: scale 1/127.
export const QUANT_SCALE = 1 / 127;
export function quantize(vec) {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] / QUANT_SCALE)));
  return out;
}
export function dequantize(int8, off, dims) {
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = int8[off + i] * QUANT_SCALE;
  return out;
}

/** Simple promise pool: run fn over items with <=limit in flight. */
export async function pool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
