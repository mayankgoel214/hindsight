/* Quote verification — ported verbatim in behaviour from
   ~/projects/Portfolio/api/_lib/pulse-core.js (the Feedback Engine).
   Pure code, no AI. Punctuation-insensitive; word units for Latin text,
   character units for CJK. Returns exact | near | unsupported. */

export const norm = (s) => (s || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[‘’`´]/g, "'")
  .replace(/[“”„«»]/g, '"')
  .replace(/[…]/g, "...")
  .replace(/\s+/g, " ")
  .trim();

export const hasCJK = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s);

// Units for fuzzy matching: characters for CJK text, words otherwise.
// Punctuation is dropped so "weeks." matches "weeks".
export const units = (s) => (hasCJK(s)
  ? [...s.replace(/[\s\p{P}]/gu, "")]
  : s.split(/[^\p{L}\p{N}']+/u).filter(Boolean));

/** Returns { status: exact|near|unsupported, score } for one quote against the source. */
export function verifyQuote(quote, source) {
  const q = norm(quote).replace(/^["']|["']$/g, "");
  const src = norm(source);
  if (!q) return { status: "unsupported", score: 0 };
  if (src.includes(q)) return { status: "exact", score: 1 };
  // Best sliding-window overlap of quote units inside the source.
  const qu = units(q);
  const su = units(src);
  if (qu.length < 2 || su.length === 0) return { status: "unsupported", score: 0 };
  const need = new Map();
  for (const u of qu) need.set(u, (need.get(u) || 0) + 1);
  let best = 0;
  const w = Math.min(qu.length, su.length);
  for (let i = 0; i + w <= su.length; i++) {
    const have = new Map();
    let hit = 0;
    for (let k = i; k < i + w; k++) {
      const u = su[k];
      const nn = (have.get(u) || 0) + 1;
      have.set(u, nn);
      if (nn <= (need.get(u) || 0)) hit++;
    }
    best = Math.max(best, hit / qu.length);
  }
  return best >= 0.8 ? { status: "near", score: best } : { status: "unsupported", score: best };
}
