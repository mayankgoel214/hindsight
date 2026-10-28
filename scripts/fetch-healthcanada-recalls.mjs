// Health Canada (Recalls and Safety Alerts, recalls-rappels.canada.ca) consumer-product recalls.
// 1. Download the open-data JSON of all recalls (Open Government Licence - Canada).
// 2. Keep Organization == "Consumer product safety", classify title+product into appliance categories.
// 3. For the subset, fetch each recall page (~1 req/s) and extract the structured fields
//    (hazard text, affected products, number sold, companies...) because the open-data JSON has no hazard narrative.
// Usage: node scripts/fetch-healthcanada-recalls.mjs [--no-details] [--cached]
//   --cached: reuse data/raw/healthcanada/hc-recalls-all.json instead of re-downloading the open-data JSON
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, mentionsSharkNinja } from './lib/categories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/raw/healthcanada');
const OPEN_DATA = 'https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json';
const UA = { 'User-Agent': 'hindsight-research/0.1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const strip = (html) => decode(html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/[​\s]+/g, ' ').trim();

// Pull text of each Drupal "field--name-xxx" block on the page.
function parseFields(html) {
  const main = html.split('<main')[1]?.split('</main>')[0] ?? html;
  const parts = main.split(/<div[^>]*class="field field--name-/).slice(1);
  const out = {};
  for (const p of parts) {
    const name = p.match(/^([a-z0-9-]+)/)[1].replace(/^field-/, '');
    if (out[name]) continue;
    out[name] = strip(p.slice(p.indexOf('>') + 1)).slice(0, 6000);
  }
  return out;
}

await mkdir(DIR, { recursive: true });
const ALL_FILE = join(DIR, 'hc-recalls-all.json');
let all;
if (process.argv.includes('--cached') && existsSync(ALL_FILE)) all = JSON.parse(await readFile(ALL_FILE, 'utf8'));
else {
  all = await (await fetch(OPEN_DATA, { headers: UA, signal: AbortSignal.timeout(120000) })).json();
  await writeFile(ALL_FILE, JSON.stringify(all));
}
const consumer = all.filter((r) => r.Organization === 'Consumer product safety');
console.log(`all recalls ${all.length}; consumer products ${consumer.length}`);

const subset = [];
for (const r of consumer) {
  const cats = classify(`${r.Title} | ${r.Product}`);
  if (!cats.length) continue;
  subset.push({
    source: 'healthcanada_recall',
    NID: r.NID, title: decode(r.Title).replace(/[​]/g, '').trim(), url: r.URL, product: r.Product, issue: r.Issue,
    category: r.Category, lastUpdated: r['Last updated'], whatToDo: strip(r['What you should do'] || ''),
    categories: cats,
  });
}
console.log('appliance subset', subset.length);

if (!process.argv.includes('--no-details')) {
  let i = 0;
  for (const s of subset) {
    i++;
    try {
      const res = await fetch(s.url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const f = parseFields(await res.text());
      Object.assign(s, {
        recallDate: f['recall-date']?.replace(/^Recall date\s*/i, ''),
        hazard: f['issue-long'], affectedProducts: f['affected-products-txt'], background: f.background,
        companies: f.companies || f['field-companies'], brand: f['brand-ref'], body: f.body,
      });
    } catch (e) {
      s.detailError = e.message;
    }
    if (i % 50 === 0) console.log(`  details ${i}/${subset.length}`);
    await sleep(1000);
  }
}
for (const s of subset) s.sharkninja = mentionsSharkNinja([s.title, s.product, s.companies, s.brand, s.affectedProducts].join(' '));
await writeFile(join(DIR, 'hc-recalls-appliances.json'), JSON.stringify(subset, null, 1));
console.log('done');
