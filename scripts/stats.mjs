// Print record counts per source / category, SharkNinja mentions and narrative text volume.
// Usage: node scripts/stats.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = join(dirname(fileURLToPath(import.meta.url)), '../data/raw');
const SOURCES = {
  cpsc_recalls: ['cpsc/cpsc-recalls-appliances.json', (r) => [r.Description, ...r.Hazards, ...r.Injuries, ...r.Remedies]],
  saferproducts_incidents: ['saferproducts/saferproducts-incidents-appliances.json', (r) => [r.incidentDescription, r.companyComments]],
  healthcanada_recalls: ['healthcanada/hc-recalls-appliances.json', (r) => [r.hazard, r.affectedProducts, r.background, r.whatToDo]],
  eu_safetygate: ['eu-safetygate/eu-alerts-appliances.json', (r) => [r.danger, r.description, r.measures]],
};
const cats = new Set();
const table = {};
for (const [name, [file, textOf]] of Object.entries(SOURCES)) {
  let rows;
  try { rows = JSON.parse(await readFile(join(RAW, file), 'utf8')); } catch { console.log(`${name}: missing`); continue; }
  const t = { records: rows.length, sharkninja: 0, narrativeChars: 0, byCat: {} };
  for (const r of rows) {
    if (r.sharkninja) t.sharkninja++;
    t.narrativeChars += textOf(r).filter(Boolean).join(' ').length;
    for (const c of r.categories) { t.byCat[c] = (t.byCat[c] || 0) + 1; cats.add(c); }
  }
  table[name] = t;
}
const names = Object.keys(table);
console.log(['category', ...names].join(' | '));
for (const c of [...cats].sort()) console.log([c, ...names.map((n) => table[n].byCat[c] || 0)].join(' | '));
for (const k of ['records', 'sharkninja', 'narrativeChars']) console.log([k, ...names.map((n) => table[n][k])].join(' | '));
