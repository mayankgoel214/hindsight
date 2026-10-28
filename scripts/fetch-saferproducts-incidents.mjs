// SaferProducts.gov public incident reports (consumer-submitted, with narrative text).
// Source: "Public Database Export" link on https://www.saferproducts.gov/PublicSearch -> https://www.saferproducts.gov/SPDB.zip
// The zip is rebuilt daily (~40 MB zipped, ~110 MB unzipped: IncidentReports.csv, Recalls.csv, Disclaimer.txt).
//
// NOTE: saferproducts.gov sits behind Akamai bot protection. On 2026-10-28 Node fetch succeeded but
// curl got HTTP 403, so this can be flaky. We do NOT try to evade the protection. If the direct download fails, download the zip in a normal browser
// (PublicSearch page -> "Public Database Export") and save it to data/raw/saferproducts/SPDB.zip, then re-run.
//
// The OData API (https://www.saferproducts.gov/WebApi/Cpsc.Cpsrms.Web.Api.svc/) needs a free
// application key (register at https://www.saferproducts.gov/WebApiRegistration/Register/); not needed for the export.
//
// Usage: node scripts/fetch-saferproducts-incidents.mjs [--cached]   (--cached: reuse existing SPDB.zip)
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToObjects } from './lib/csv.mjs';
import { classify, mentionsSharkNinja } from './lib/categories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/raw/saferproducts');
const ZIP = join(DIR, 'SPDB.zip');
const URL_ZIP = 'https://www.saferproducts.gov/SPDB.zip';

// CPSC/NEISS product codes (the number in "Product Type", e.g. "Electric Blenders (215)") -> our category.
const CODE_MAP = {
  blender_food_processor: [215, 275, 231, 271],
  pressure_multi_cooker: [412, 268, 219],
  oven_toaster: [216, 234, 235],
  grill: [3248, 3233, 3229, 3249, 3218, 223],
  coffee_maker: [217, 405, 452],
  kettle: [269],
  ice_cream_frozen_drink: [274],
  vacuum: [115],
  hair_care: [1602, 1682, 1683],
  fan_heater_air: [348, 306, 380, 388, 304, 307, 393, 391, 394, 399],
  li_ion_battery_device: [884, 883, 5025, 5022, 5042, 5024],
};
const codeToCat = new Map(Object.entries(CODE_MAP).flatMap(([cat, codes]) => codes.map((c) => [String(c), cat])));

await mkdir(DIR, { recursive: true });
if (process.argv.includes('--cached') && existsSync(ZIP)) console.log('using cached', ZIP);
else try {
  const res = await fetch(URL_ZIP, { headers: { 'User-Agent': 'hindsight-research/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(ZIP, Buffer.from(await res.arrayBuffer()));
  console.log('downloaded', URL_ZIP);
} catch (e) {
  console.warn(`direct download failed (${e.message}); expected behind Akamai.`);
  if (!existsSync(ZIP)) {
    console.error(`Download ${URL_ZIP} in a browser and save it to ${ZIP}, then re-run.`);
    process.exit(1);
  }
  console.log('using existing', ZIP);
}
execFileSync('unzip', ['-o', '-q', ZIP, '-d', DIR]);

// File is Windows-1252; first line is a disclaimer, header is line 2.
const text = new TextDecoder('windows-1252').decode(await readFile(join(DIR, 'IncidentReports.csv')));
const rows = csvToObjects(text, { headerRow: text.startsWith('Report No.') ? 0 : 1 });
console.log('incident reports in export:', rows.length);

const out = [];
for (const r of rows) {
  const cats = new Set();
  const code = r['Product Code'];
  if (codeToCat.has(code)) cats.add(codeToCat.get(code));
  // keyword pass on the short product description catches miscoded items (e.g. air fryers filed under ovens)
  for (const c of classify(`${r['Product Description']} | ${r['Product Type']}`)) cats.add(c);
  // exclude full-size ranges / wall ovens / water heaters that the keyword pass might pull in via "oven"/"heater"
  // full-size ranges/ovens, microwaves and water heaters are out of scope even if the text says "air fry"
  if (/^(278|279|280|281|264|118|119|133|134|236|242|312)$/.test(code)) continue;
  if (/^(1240|1461|1448|381)$/.test(code)) cats.delete('fan_heater_air'); // aquarium heaters, leaf blowers, mowers, window ACs
  if (!cats.size) continue;
  const brandText = [r['Manufacturer / Importer / Private Labeler Name'], r['Brand'], r['Product Description'], r['Model Name or Number']].join(' ');
  out.push({
    source: 'saferproducts_incident',
    reportNo: r['Report No.'],
    reportDate: r['Report Date'],
    publicationDate: r['Publication Date'],
    submitterCategory: r['Category of Submitter'],
    productDescription: r['Product Description'],
    productCategory: r['Product Category'],
    productSubCategory: r['Product Sub Category'],
    productType: r['Product Type'],
    productCode: code,
    manufacturer: r['Manufacturer / Importer / Private Labeler Name'],
    brand: r['Brand'],
    model: r['Model Name or Number'],
    serial: r['Serial Number'],
    upc: r['UPC'],
    dateManufactured: r['Date Manufactured'],
    mfrDateCode: r['Manufacturer Date Code'],
    retailer: r['Retailer'],
    purchaseDate: r['Purchase Date'],
    incidentDescription: r['Incident Description'],
    state: r['State'],
    location: r['Location'],
    victimSeverity: r['(Primary) Victim Severity'],
    victimSex: r["(Primary) Victim's Sex"],
    victimAge: r["(Primary) Victim's Age (years)"],
    submitterHasProduct: r['Submitter Has Product'],
    damagedBefore: r['Product Was Damaged Before Incident'],
    modifiedBefore: r['Product Was Modified Before Incident'],
    contactedManufacturer: r['Have You Contacted The Manufacturer'],
    companyComments: r['Company Comments'],
    associatedReports: r['Associated Report Numbers'],
    categories: [...cats],
    sharkninja: mentionsSharkNinja(brandText) || /\bshark ?ninja\b|\beuro-?pro\b/i.test(brandText) || (/^(shark|ninja)\b/i.test(r['Brand']) && cats.size > 0),
  });
}
await writeFile(join(DIR, 'saferproducts-incidents-appliances.json'), JSON.stringify(out, null, 1));
console.log('appliance subset:', out.length);
