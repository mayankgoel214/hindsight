// Record the ~55 s muted demo video of the live Hindsight site.
// usage: node scripts/record-demo.mjs            -> real search (uses 1 of the 30/hour API calls)
//        DRY=1 node scripts/record-demo.mjs      -> replays a cached /api/search response (no API call)
// Writes docs/demo.mp4 (H.264, yuv420p, faststart) and docs/demo-poster.png.
// Playwright is borrowed from ~/projects/Verity/node_modules; needs ffmpeg on PATH.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(os.homedir(), "projects/Verity/package.json"));
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = "https://hindsight.mayank-goel.com/";
const QUERY = "glass air fryer basket shatters";
const DRY = !!process.env.DRY;
const CACHE = process.env.SEARCH_CACHE || path.join(os.tmpdir(), "hindsight-demo-search.json");
const W = 1280, H = 800;

const raw = fs.mkdtempSync(path.join(os.tmpdir(), "hs-demo-"));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: raw, size: { width: W, height: H } } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL.slice(0, -1) });
const page = await ctx.newPage();
const t0 = Date.now();

if (DRY) {
  if (!fs.existsSync(CACHE)) throw new Error(`DRY needs a cached response at ${CACHE}`);
  await page.route("**/api/search", (r) => r.fulfill({ status: 200, contentType: "application/json", body: fs.readFileSync(CACHE, "utf8") }));
} else {
  page.on("response", async (r) => { if (r.url().includes("/api/search") && r.ok()) fs.writeFileSync(CACHE, await r.text()); });
}

const wait = (ms) => page.waitForTimeout(ms);

await page.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
await page.waitForSelector("#featuredGrid > *");
await wait(600);

// ---- overlay helpers (live in the page DOM) ----
await page.addStyleTag({ content: `
  #demo-cap{position:fixed;left:0;right:0;bottom:0;z-index:99999;display:flex;justify-content:center;pointer-events:none;
    padding:20px 32px 24px;background:rgba(15,23,42,.94);color:#fff;font:600 33px/1.25 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    text-align:center;opacity:0;transition:opacity .35s ease}
  #demo-cap.on{opacity:1}
  #demo-cap span{max-width:1230px;text-wrap:balance}
  #demo-card{position:fixed;inset:0;z-index:100000;background:#0f172a;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:22px;text-align:center;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;opacity:0;transition:opacity .5s ease;pointer-events:none}
  #demo-card.on{opacity:1}
  #demo-card .t{font-size:64px;font-weight:700;letter-spacing:-.02em}
  #demo-card .s{font-size:32px;color:#cbd5e1;font-weight:500}
  #demo-card .mk{width:76px;height:76px;border-radius:16px;background:#fff;color:#0f172a;font-size:46px;font-weight:800;display:grid;place-items:center}
  .demo-ring{position:fixed;z-index:99998;border:4px solid #f97316;border-radius:10px;pointer-events:none;opacity:0;transition:opacity .3s ease;box-shadow:0 0 0 4px rgba(249,115,22,.18)}
  .demo-arrow{position:fixed;z-index:99998;pointer-events:none;opacity:0;transition:opacity .3s ease}
  .demo-ring.on,.demo-arrow.on{opacity:1}
` });
await page.evaluate(() => {
  const cap = document.createElement("div"); cap.id = "demo-cap"; cap.innerHTML = "<span></span>"; document.body.append(cap);
  const card = document.createElement("div"); card.id = "demo-card"; document.body.append(card);
  window.__demo = {
    cap(text) { cap.querySelector("span").textContent = text; cap.classList.add("on"); },
    uncap() { cap.classList.remove("on"); },
    card(html) { card.innerHTML = html; card.classList.add("on"); },
    uncard() { card.classList.remove("on"); },
    // ring + small arrow pointing at an element (fixed coords; call after scrolling stops)
    point(sel, side = "left") {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel; if (!el) return false;
      const r = el.getBoundingClientRect(), pad = 6;
      const ring = document.createElement("div"); ring.className = "demo-ring";
      Object.assign(ring.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
      const a = document.createElement("div"); a.className = "demo-arrow";
      a.innerHTML = `<svg width="54" height="34" viewBox="0 0 54 34"><path d="M2 17h38M30 5l14 12-14 12" fill="none" stroke="#f97316" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      if (side === "left") Object.assign(a.style, { left: r.left - pad - 62 + "px", top: r.top + r.height / 2 - 17 + "px" });
      else { a.style.transform = "rotate(90deg)"; Object.assign(a.style, { left: r.left + Math.min(r.width / 2, 120) - 27 + "px", top: r.top - pad - 50 + "px" }); }
      document.body.append(ring, a);
      requestAnimationFrame(() => { ring.classList.add("on"); a.classList.add("on"); });
      return true;
    },
    unpoint() { document.querySelectorAll(".demo-ring,.demo-arrow").forEach((n) => { n.classList.remove("on"); setTimeout(() => n.remove(), 350); }); },
    // eased scroll so the element's top lands at `top` px from the viewport top
    scrollTo(target, ms = 1200, top = 90) {
      let y = typeof target === "number" ? target : (() => { const el = document.querySelector(target); return el ? el.getBoundingClientRect().top + scrollY - top : scrollY; })();
      y = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
      const y0 = scrollY, t0 = performance.now();
      return new Promise((res) => { const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, y0 + (y - y0) * e); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
    },
  };
});
const D = (fn, ...a) => page.evaluate(fn, ...a);
const cap = (t) => D((t) => __demo.cap(t), t);
const uncap = async () => { await D(() => __demo.uncap()); await wait(380); };
const point = (s, side) => D(([s, side]) => __demo.point(s, side), [s, side]);
const unpoint = () => D(() => __demo.unpoint());
const scroll = (t, ms, top) => D(([t, ms, top]) => __demo.scrollTo(t, ms, top), [t, ms, top]);
const tag = (sel, label) => page.evaluate(([sel, label]) => { const el = document.querySelector(sel); if (el) el.setAttribute("data-demo", label); return !!el; }, [sel, label]);

// ---- 1. title card ----
await D(() => __demo.card(`<div class="mk">H</div><div class="t">Hindsight — has this failed before?</div><div class="s">A concept tool for Ninja new product development</div>`));
const start = (Date.now() - t0) / 1000 + 0.05;
await wait(2500);
await D(() => __demo.uncard()); await wait(600);

// ---- 2. home + featured patterns ----
await cap("5,179 real product-safety records — recalls, safety alerts, and consumer reports — grouped by how products fail.");
await wait(800);
await scroll("#featured", 2400, 110);
await wait(1700);
await uncap();

// ---- 3. type + search ----
await scroll(0, 900); await wait(200);
await cap("Describe a part or concept in plain words.");
await page.click("#q"); await wait(300);
await page.type("#q", QUERY, { delay: 75 });
await wait(500);
await page.click("#searchForm button[type=submit]");
await page.waitForSelector("#searchResults .group .group-stats", { timeout: 30000 });
await page.waitForSelector("#dfmeaRows:not([hidden]) tbody tr", { timeout: 30000 });
const firstFm = await page.$eval("#searchResults .group .fm", (e) => e.textContent.trim());
if (!/glass/i.test(firstFm)) console.warn("WARNING: first pattern is", firstFm);
await wait(400);
await uncap();

await scroll("#searchResults", 1300, 80);
await cap("Every similar failure across all brands, grouped by failure mode.");
await wait(3000);
await uncap();
await point("#searchResults .group .group-stats .stat.verified", "top");
await point("#searchResults .group .group-stats .stat.unverified", "top");
await cap("Official recalls vs. unverified consumer reports — always labeled.");
await wait(3300);
await unpoint(); await uncap();

// ---- 4. verified example quote ----
await tag("#searchResults .group .rec-verified", "verified-rec");
await scroll('[data-demo="verified-rec"]', 1300, 150);
await point('[data-demo="verified-rec"] .rec-quote', "left");
await cap("Every claim quotes the source record and links to it.");
await wait(1700);
await point('[data-demo="verified-rec"] .rec-source', "top");
await wait(1900);
await unpoint(); await uncap();

// ---- 5. mitigation + verification test ----
await tag("#searchResults .group .group-notes", "notes");
await scroll('[data-demo="notes"]', 1100, 120);
await point('[data-demo="notes"]', "left");
await cap("A suggested design fix and a test to run — and the standard to check against.");
await wait(3500);
await unpoint(); await uncap();

// ---- 6. DFMEA rows + copy ----
await scroll("#dfmeaRows", 1700, 90);
await cap("DFMEA-ready rows. One click copies them into Excel.");
await wait(1500);
await point("#copyTsv", "left"); await wait(700);
await page.click("#copyTsv");
await wait(2000);
await unpoint(); await uncap();

// ---- 7. checklist ----
await scroll(0, 800);
await page.click('[data-view="checklist"]');
await page.waitForSelector("#checklistBody > *"); await wait(300);
await page.selectOption("#cCategory", "air_fryer"); await wait(300);
await page.selectOption("#cGate", "DVT"); await wait(400);
await cap("A design-review checklist by gate: P0, P2, DVT, TRA.");
await point("#cGate", "top");
await wait(2000);
await unpoint();
await scroll(220, 1500);
await wait(900);
await uncap();

// ---- 8. accuracy ----
await scroll(0, 600);
await page.click('[data-view="accuracy"]');
await page.waitForSelector("#accuracyBody .acc-stat"); await wait(300);
const qs = await page.$$eval("#accuracyBody .acc-stat", (els) => { const e = els.find((x) => /quote-support/i.test(x.textContent)); e?.setAttribute("data-demo", "qs"); return e?.querySelector(".n")?.textContent.trim(); });
console.log("quote-support on page:", qs);
await point('[data-demo="qs"]', "top");
await cap(`Measured, not assumed: ${qs} of quotes are found in the source record, checked in code.`);
await wait(3500);
await unpoint(); await uncap();

// ---- 9. end card ----
await D(() => __demo.card(`<div class="mk">H</div><div class="t">hindsight.mayank-goel.com</div><div class="s">Built by Mayank Goel · concept, not affiliated with SharkNinja</div>`));
await wait(3000);
await D(() => document.body.style.background = '#fff');
const end = (Date.now() - t0) / 1000;

await ctx.close(); await browser.close();
const webm = path.join(raw, fs.readdirSync(raw).find((f) => f.endsWith(".webm")));
const docs = path.join(ROOT, "docs"); fs.mkdirSync(docs, { recursive: true });
const mp4 = path.join(docs, "demo.mp4"), png = path.join(docs, "demo-poster.png");
// Find the title card and end card in the raw video by brightness (both are dark navy; the site is white).
// Wall-clock offsets drift against the webm timeline, so trim on what is actually in the frames.
const stats = execFileSync("ffmpeg", ["-hide_banner", "-i", webm, "-vf", "fps=20,scale=160:100,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] });
const fr = []; let t = null;
for (const line of stats.split("\n")) { const m = line.match(/pts_time:([\d.]+)/); if (m) t = +m[1]; const y = line.match(/YAVG=([\d.]+)/); if (y && t != null) fr.push([t, +y[1]]); }
const dark = fr.filter(([, y]) => y < 60).map(([t]) => t);
if (!dark.length) throw new Error("could not find title/end cards in the raw video");
const vStart = dark[0], vEnd = dark[dark.length - 1] + 0.05;
const dur = (vEnd - vStart).toFixed(2);
const speed = Math.max(1, (vEnd - vStart) / 59.5); // the webm runs a little slow; nudge it under 60 s (<= ~3%, not noticeable)
console.log(`raw video: title card at ${vStart}s, end card until ${vEnd}s (wall-clock estimate was ${start.toFixed(2)}–${end.toFixed(2)})`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", vStart.toFixed(2), "-t", dur, "-i", webm,
  "-vf", `setpts=PTS/${speed.toFixed(4)},scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "24",
  "-tune", "stillimage", "-an", "-movflags", "+faststart", mp4]);
// poster: the title card
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", process.env.POSTER_AT || "1.2", "-i", mp4, "-frames:v", "1", png]);
fs.copyFileSync(webm, path.join(os.tmpdir(), "hindsight-demo-raw.webm"));
fs.rmSync(raw, { recursive: true, force: true });
console.log(`wrote ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB, ${dur}s) and ${png}`);
