// Fetch all CPSC recalls 2010-01-01..today from the SaferProducts.gov Recall REST API,
// save the full raw dump, then write the small-appliance subset.
// Usage: node scripts/fetch-cpsc-recalls.mjs [--refresh]   (without --refresh, re-filters the cached full dump)
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, mentionsSharkNinja } from './lib/categories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data/raw/cpsc');
const API = 'https://www.saferproducts.gov/RestWebServices/Recall';
const START_YEAR = 2010;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'hindsight-research/0.1' }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw e;
      console.warn(`  retry ${i} ${url}: ${e.message}`);
      await sleep(2000 * i);
    }
  }
}

const names = (arr, k = 'Name') => (arr || []).map((x) => x?.[k]).filter(Boolean);

function trim(r) {
  return {
    source: 'cpsc_recall',
    RecallID: r.RecallID,
    RecallNumber: r.RecallNumber,
    RecallDate: r.RecallDate?.slice(0, 10),
    Title: r.Title,
    URL: r.URL,
    Description: r.Description,
    Products: (r.Products || []).map((p) => ({ Name: p.Name, Description: p.Description, Model: p.Model, Type: p.Type, CategoryID: p.CategoryID, NumberOfUnits: p.NumberOfUnits })),
    Hazards: names(r.Hazards),
    HazardTypes: names(r.Hazards, 'HazardType'),
    Remedies: names(r.Remedies),
    RemedyOptions: names(r.RemedyOptions, 'Option'),
    Injuries: names(r.Injuries),
    Manufacturers: names(r.Manufacturers),
    Importers: names(r.Importers),
    Distributors: names(r.Distributors),
    Retailers: names(r.Retailers),
    ManufacturerCountries: names(r.ManufacturerCountries, 'Country'),
    UPCs: r.ProductUPCs || [],
    Images: (r.Images || []).map((i) => ({ URL: i.URL, Caption: i.Caption })),
    ConsumerContact: r.ConsumerContact,
  };
}

await mkdir(RAW, { recursive: true });
const ALL_FILE = join(RAW, 'cpsc-recalls-all.json');
const refresh = process.argv.includes('--refresh') || !existsSync(ALL_FILE);
const all = new Map();
const thisYear = new Date().getUTCFullYear();
if (!refresh) for (const r of JSON.parse(await readFile(ALL_FILE, 'utf8'))) all.set(r.RecallID, r);
else for (let y = START_YEAR; y <= thisYear; y++) {
  // half-year windows keep responses small (API returns everything in one array, no paging)
  for (const [a, b] of [[`${y}-01-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-12-31`]]) {
    const rows = await getJson(`${API}?format=json&RecallDateStart=${a}&RecallDateEnd=${b}`);
    for (const r of rows) all.set(r.RecallID, r);
    console.log(`${a}..${b}: ${rows.length}`);
    await sleep(500); // be polite; no documented rate limit
  }
}
const allRows = [...all.values()].sort((x, y) => (x.RecallDate < y.RecallDate ? 1 : -1));
if (refresh) await writeFile(ALL_FILE, JSON.stringify(allRows));

const subset = [];
for (const r of allRows) {
  const t = trim(r);
  // classify on title + product names/types (not the long Description, which is noisy)
  const matchText = [t.Title, ...t.Products.map((p) => `${p.Name} ${p.Type}`)].join(' | ');
  const cats = classify(matchText);
  if (!cats.length) continue;
  const brandText = [t.Title, t.Description, ...t.Manufacturers, ...t.Importers, ...t.Distributors, ...t.Products.map((p) => p.Name)].join(' ');
  subset.push({ ...t, categories: cats, sharkninja: mentionsSharkNinja(brandText) });
}
await writeFile(join(RAW, 'cpsc-recalls-appliances.json'), JSON.stringify(subset, null, 1));
console.log(`total recalls ${allRows.length}; appliance subset ${subset.length}`);
