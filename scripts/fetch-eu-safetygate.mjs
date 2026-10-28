// EU Safety Gate (formerly RAPEX) alerts via the official weekly-report XML downloads.
// Index of all weekly reports (2005..now): https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en
// Listed on data.europa.eu as dataset "rapex-rapid-alert-system-non-food" (DG JUST). Reuse: Commission
// Decision 2011/833/EU (free reuse with acknowledgement of source).
// Usage: node scripts/fetch-eu-safetygate.mjs [--from=2010] [--refresh] [--no-fetch]
//   --no-fetch: only re-filter the cached alerts. The server can be very slow (60s+ per weekly report); re-run to resume.
//   Parsed alerts are cached in data/raw/eu-safetygate/eu-alerts-all.json; without --refresh only new weeks are fetched.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, mentionsSharkNinja } from './lib/categories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/raw/eu-safetygate');
const INDEX = 'https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en';
const FROM = +(process.argv.find((a) => a.startsWith('--from='))?.split('=')[1] ?? 2010);
const UA = { 'User-Agent': 'hindsight-research/0.1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unxml = (s) => (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
const tag = (xml, t) => unxml(xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`))?.[1]);
const tags = (xml, t) => [...xml.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'g'))].map((m) => unxml(m[1]));

async function get(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(3000 * i);
    }
  }
}

await mkdir(DIR, { recursive: true });
const ALL = join(DIR, 'eu-alerts-all.json');
const cache = !process.argv.includes('--refresh') && existsSync(ALL) ? JSON.parse(await readFile(ALL, 'utf8')) : [];
const doneReports = new Set(cache.map((a) => a.report));

const index = process.argv.includes('--no-fetch') ? '' : await get(INDEX);
const reports = tags(index, 'weeklyReport').map((w) => ({ ref: tag(w, 'reference'), year: +tag(w, 'year'), date: tag(w, 'publicationDate'), url: tag(w, 'URL') }))
  .filter((r) => r.year >= FROM && !doneReports.has(r.ref));
console.log(`weekly reports to fetch: ${reports.length}`);

const alerts = [...cache];
let n = 0;
for (const r of reports) {
  try {
    const xml = await get(r.url);
    for (const nx of tags(xml, 'notifications')) {
      alerts.push({
        source: 'eu_safetygate', report: r.ref, reportDate: r.date,
        caseNumber: tag(nx, 'caseNumber'), url: tag(nx, 'reference'), category: tag(nx, 'category'),
        product: tag(nx, 'product'), brand: tag(nx, 'brand'), name: tag(nx, 'name'), model: tag(nx, 'type_numberOfModel'),
        batch: tag(nx, 'batchNumber'), barcode: tag(nx, 'barcode'), riskType: tag(nx, 'riskType'), riskLevel: tag(nx, 'level'),
        danger: tag(nx, 'danger'), measures: tag(nx, 'measures'), description: tag(nx, 'description'),
        notifyingCountry: tag(nx, 'notifyingCountry'), countryOfOrigin: tag(nx, 'countryOfOrigin'), alertType: tag(nx, 'type'),
        recallUrl: tag(nx, 'URLrecall'), pictures: tags(nx, 'picture'),
      });
    }
  } catch (e) {
    console.warn(`  ${r.ref} failed: ${e.message}`);
  }
  if (++n % 50 === 0) {
    console.log(`  ${n}/${reports.length} reports, ${alerts.length} alerts`);
    await writeFile(ALL, JSON.stringify(alerts)); // checkpoint
  }
  await sleep(400);
}
await writeFile(ALL, JSON.stringify(alerts));

// Appliance subset: classify on product type + product name (+ category for context); skip food/cosmetics/toys/vehicles.
const SKIP_CAT = /^(Toys|Cosmetics|Motor vehicles|Food|Clothing|Jewellery|Childcare)/i;
const subset = [];
for (const a of alerts) {
  if (SKIP_CAT.test(a.category)) continue;
  const cats = classify(`${a.product} | ${a.name}`);
  if (!cats.length) continue;
  subset.push({ ...a, categories: cats, sharkninja: mentionsSharkNinja(`${a.brand} ${a.name} ${a.description}`) || /^(shark ?ninja|ninja|shark)$/i.test(a.brand) });
}
await writeFile(join(DIR, 'eu-alerts-appliances.json'), JSON.stringify(subset, null, 1));
console.log(`alerts total ${alerts.length}; appliance subset ${subset.length}`);
