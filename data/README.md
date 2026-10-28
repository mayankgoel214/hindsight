# Hindsight raw data: small household appliance failures

Pulled **2026-10-28**. All sources are official and free. Every file comes from a script in `../scripts/`, which uses Node 20+ ESM, built-in `fetch` and no npm dependencies.

Every appliance subset is tagged by `scripts/lib/categories.mjs`, a keyword classifier that runs on the title, product name and product type. The long free text is not classified because it adds noise. A record can get more than one category. Each record also carries `sharkninja: true|false`, which matches SharkNinja / Euro-Pro / Ninja <product line> / Shark <product line>.

`node scripts/stats.mjs` reprints all of the numbers below.

## Counts per source and category

| category | CPSC recalls | SaferProducts incidents | Health Canada recalls | EU Safety Gate |
|---|---|---|---|---|
| air_fryer | 6 | 373 | 4 | 9 |
| blender_food_processor | 18 | 928 | 13 | 22 |
| coffee_maker | 24 | 1431 | 13 | 6 |
| fan_heater_air (fans, space heaters, purifiers, (de)humidifiers) | 113 | 2334 | 91 | 132 |
| grill (incl. outdoor/pellet, griddles) | 32 | 998 | 41 | 21 |
| hair_care (dryers, stylers, straighteners) | 21 | 814 | 16 | 119 |
| ice_cream_frozen_drink | 4 | 347 | 1 | 0 |
| kettle | 16 | 276 | 18 | 33 |
| li_ion_battery_device (batteries, chargers, e-bikes, scooters, cordless) | 186 | 2539 | 124 | 155 |
| oven_toaster (countertop only) | 9 | 909 | 19 | 14 |
| pressure_multi_cooker (incl. slow/rice cookers, deep fryers) | 13 | 605 | 8 | 26 |
| vacuum (incl. cordless/robot, steam mops) | 19 | 592 | 21 | 15 |
| **records (unique)** | **445** | **11,748** | **355** | **548** |
| **SharkNinja mentions** | **3** | **361** | **3** | **0** |
| narrative text (chars) | 0.52 M | 9.75 M | 0.11 M | 0.40 M |

Total: about 13,100 records and about 10.8 M characters of narrative text (roughly 2.7 M tokens).

The three SharkNinja recalls appear in both CPSC and Health Canada:
- Foodi OP300 pressure cooker (2025)
- Ninja BL660 blender (2015)
- Shark vacuums by Euro-Pro (2015)

The 361 SharkNinja incident reports break down as:
- blenders: 133
- vacuums: 114
- multi-cookers: 43
- toaster ovens: 26
- air fryers: 23
- Creami: 23
- coffee: 19
- grills: 9
- other categories: the remaining few

Some of these 361 are accessory brands that mention "Ninja", for example grill stands. This is a known source of false positives.

---

## 1. CPSC Recalls API (works, no key)

- **URL:** `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=YYYY-MM-DD&RecallDateEnd=YYYY-MM-DD`. Other filters include `ProductName`, `RecallNumber` and so on.
- **Script:** `scripts/fetch-cpsc-recalls.mjs [--refresh]`. It queries 2010-01 to today in half-year windows. The API has no paging and returns one array.
- **Terms:** US federal government work, public domain. No key and no documented rate limit. The script waits 0.5 s between calls.
- **Files:**
  - `raw/cpsc/cpsc-recalls-all.json`: all 5,292 recalls from 2010 on, as untouched API objects.
  - `raw/cpsc/cpsc-recalls-appliances.json`: the 445-record subset, trimmed.
- **Fields:** RecallID, RecallNumber, RecallDate, Title, URL, Description, Products[{Name, Description, Model, Type, CategoryID, NumberOfUnits}], Hazards, HazardTypes, Remedies, RemedyOptions, Injuries, Manufacturers, Importers, Distributors, Retailers, ManufacturerCountries, UPCs, Images[{URL, Caption}], ConsumerContact, categories, sharkninja.

## 2. SaferProducts.gov consumer incident reports (works, the best narrative source)

- **Bulk export:** `https://www.saferproducts.gov/SPDB.zip`. This is the "Public Database Export" link on https://www.saferproducts.gov/PublicSearch. It is about 40 MB zipped and holds `IncidentReports.csv` (100 MB), `Recalls.csv` and `Disclaimer.txt`. CPSC rebuilds it daily.
- **Access:** the site is behind Akamai bot protection.
  - curl gets HTTP 403.
  - Node `fetch` worked on 2026-10-28.
  - The first copy was downloaded with a normal (Playwright) browser click.
  - If the script gets a 403, download the zip in a browser to `raw/saferproducts/SPDB.zip` and run with `--cached`. The script does not try to evade the protection.
- **OData API:** `https://www.saferproducts.gov/WebApi/Cpsc.Cpsrms.Web.Api.svc/IncidentDetails` returns 401 without a key. The key is free but needs a registration at `/WebApiRegistration/Register/`, which Mayank has to do himself. The export makes the key unnecessary.
- **Terms:** public CPSC database. Disclaimer: CPSC does not guarantee accuracy, especially for reports submitted by the public. Reports are unverified consumer claims and many include a manufacturer response in `companyComments`.
- **Coverage:** exactly 70,000 reports from 2011-04 to 2026-10. That round number could mean the export is capped; this has not been verified.
- **How the subset is built:**
  - It uses CPSC product codes, for example 215 = blenders and 1602 = hair dryers; the full list is `CODE_MAP` in the script.
  - It adds keyword hits on the product description.
  - It drops full-size ranges, microwaves and water heaters.
- **Script:** `scripts/fetch-saferproducts-incidents.mjs [--cached]`
- **Files:** `raw/saferproducts/IncidentReports.csv` (full) and `raw/saferproducts/saferproducts-incidents-appliances.json` (11,748 records).
- **Fields:** reportNo, reportDate, publicationDate, submitterCategory, productDescription, productCategory, productSubCategory, productType, productCode, manufacturer, brand, model, serial, upc, dateManufactured, mfrDateCode, retailer, purchaseDate, **incidentDescription**, state, location, victimSeverity, victimSex, victimAge, submitterHasProduct, damagedBefore, modifiedBefore, contactedManufacturer, **companyComments**, associatedReports, categories, sharkninja.

## 3. Health Canada recalls (works, but the detail text is incomplete)

- **URL:** `https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json`. It is 15 MB, holds all 34,303 Canadian recalls, and is filtered to `Organization == "Consumer product safety"` (5,224).
- **Terms:** Open Government Licence – Canada.
- **Script:** `scripts/fetch-healthcanada-recalls.mjs [--cached] [--no-details]`
- **Files:** `raw/healthcanada/hc-recalls-all.json` and `raw/healthcanada/hc-recalls-appliances.json` (355 records).
- **Fields:** NID, title, url, product, issue (a short hazard label), category, lastUpdated, whatToDo, categories, sharkninja.
- **Missing detail text:** the open-data JSON has no hazard narrative. The script can scrape each recall page (about 1 request/s) to add hazard, affectedProducts, background (units sold), companies and recallDate. That step **did not finish** on 2026-10-28 because the network kept failing, so the current subset has no detail text. To fill it in, run `node scripts/fetch-healthcanada-recalls.mjs --cached`.
- **Overlap with CPSC:** many of these are joint US/Canada recalls that duplicate CPSC.

## 4. EU Safety Gate (formerly RAPEX) (works, slow server, partial pull)

- **Index:** `https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en` lists 1,121 weekly reports from 2005 to now. Each report's URL returns XML; decode the `&amp;` before requesting it.
- **Catalog entry:** data.europa.eu dataset `rapex-rapid-alert-system-non-food` (DG JUST).
- **Terms:** reusable with acknowledgement under Commission Decision 2011/833/EU. No key.
- **Pull is partial:** the server took 60 s or more per report and the network dropped, so the pull is **partial: weekly reports from mid-2020 to 2026-10** (19,562 alerts of all types). To resume, run `node scripts/fetch-eu-safetygate.mjs`; it skips weeks already cached. `--no-fetch` only re-filters the cache.
- **Files:** `raw/eu-safetygate/eu-alerts-all.json` and `raw/eu-safetygate/eu-alerts-appliances.json` (548 records).
- **Fields:** caseNumber, url, report, reportDate, category, product, brand, name, model, batch, barcode, riskType, riskLevel, **danger** (the hazard narrative, often citing the EN standard that failed), measures, description, notifyingCountry, countryOfOrigin, alertType, recallUrl, pictures, categories, sharkninja.

## Investigated, not downloaded

- **Australia ACCC** (productsafety.gov.au): returns HTTP 403 to scripts and has no bulk open-data feed on data.gov.au.
- **OECD GlobalRecalls:** a JavaScript single-page app with no documented bulk export. It mostly re-publishes CPSC, Health Canada, EU and ACCC data.
- **NEISS** (CPSC injury surveillance): downloadable and has narratives, but carries no brand or model. It could be added later for injury-pattern statistics.

## Known noise

- `li_ion_battery_device` is broad. It includes power tools, mowers and e-bikes.
- `fan_heater_air` includes patio and propane heaters.
- EU `grill` picks up a few "LED grill decoration" items.

---

## Example records (trimmed)

**CPSC recall**

```json
{"RecallID":10257,"RecallNumber":"25247","RecallDate":"2025-05-01",
 "Title":"SharkNinja Recalls 1.8 Million Foodi Multi-Function Pressure Cookers Due to Burn Hazard; Serious Burn Injuries Reported",
 "Products":[{"Name":"SharkNinja Foodi OP300 Series Multi-Function Pressure Cookers","NumberOfUnits":"About 1,846,400 (In addition, about 184,240 were sold in Canada)"}],
 "Hazards":["The pressure-cooking lid can be opened during use, causing hot contents to escape, posing a risk of burn injuries to consumers."],
 "Injuries":["SharkNinja has received 106 reports of burn injuries, including more than 50 reports of second- or third-degree burns to the face or body, with 26 lawsuits filed."],
 "categories":["pressure_multi_cooker"],"sharkninja":true}
```

**SaferProducts incident**

```json
{"reportNo":"20260805-0DEFF-2147312850","reportDate":"8/5/2026","productDescription":"360 Air Fryer Oven",
 "productType":"Other Cookware (465)","manufacturer":"TRISTAR PRODUCTS, INC.","brand":"Empower Brands- Emeril Lagasse","model":"AFO-001",
 "incidentDescription":"The Emeril Lagasse 360 Air Fryer turned on and started preheating by itself. We shut it off but this happened 3 more times ... An appliance should not turn on by itself…",
 "victimSeverity":"Incident, No Injury",
 "companyComments":"(8/20/2026) TRISTAR PRODUCTS, INC.: Thank you for providing us with this information…",
 "categories":["air_fryer","oven_toaster"],"sharkninja":false}
```

**EU Safety Gate alert**

```json
{"caseNumber":"SR/02907/26","reportDate":"16/10/2026","url":"https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10099014",
 "category":"Electrical appliances and equipment","product":"Hairdryer","brand":"*JOOAYOU*","name":"Hair Dryer",
 "riskType":"Electric shock, Fire","riskLevel":"Serious risk",
 "danger":"Due to incorrect design of the product, live parts (such as the heating spring) can be easily accessed through the air outlet of the appliance... The product overheats which could cause a fire…",
 "countryOfOrigin":"People's Republic of China","categories":["hair_care"]}
```
