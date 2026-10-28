// Shared keyword classifier for small household appliances.
// classify(text) -> array of category ids. Match is case-insensitive on word-ish boundaries.
// Keep the matching text to titles / product names / product types where possible;
// long free-text descriptions mention incidental words ("fan", "battery") and inflate counts.

export const CATEGORIES = {
  blender_food_processor: {
    include: [
      /\bblenders?\b/, /\bfood processors?\b/, /\bjuicers?\b/, /\bstand mixers?\b/, /\bhand mixers?\b/,
      /\bimmersion blenders?\b/, /\bfood choppers?\b/, /\bnutri ?bullet\b/, /\bmagic bullet\b/, /\bvitamix\b/,
    ],
  },
  air_fryer: { include: [/\bair ?fryers?\b/, /\bair fry/] },
  pressure_multi_cooker: {
    include: [
      /\bpressure cookers?\b/, /\bmulti-? ?cookers?\b/, /\bslow cookers?\b/, /\brice cookers?\b/,
      /\binstant pot\b/, /\bcrock-?pot\b/, /\bsous vide\b/, /\belectric skillets?\b/, /\bdeep fryers?\b/,
      /\bfoodi\b/,
    ],
  },
  oven_toaster: {
    include: [
      /\btoasters?\b/, /\btoaster ovens?\b/, /\bcountertop ovens?\b/, /\bconvection ovens?\b/, /\bpizza ovens?\b/,
      /\bair fryer ovens?\b/, /\bsandwich makers?\b/, /\bwaffle makers?\b/, /\bpanini\b/,
    ],
    exclude: [/\b(gas|electric) ranges?\b/, /\bwall ovens?\b/, /\btoaster pastr/],
  },
  grill: {
    include: [
      /\bgrills?\b/, /\bpellet\b/, /\bsmokers?\b/, /\bgriddles?\b/, /\bbarbecues?\b/, /\bbbq\b/, /\bkamado\b/,
    ],
    exclude: [/\bgrill (brush|cover|tool|light|thermometer|mat)(es|s)?\b/, /\bgrilles?\b/, /\bgrilled\b/, /\bsmoke (alarm|detector)s?\b/, /\bpellet (gun|stove)s?\b/, /\bair ?soft\b/],
  },
  coffee_maker: {
    include: [
      /\bcoffee ?makers?\b/, /\bespresso\b/, /\bcoffee (brewer|machine|grinder)s?\b/, /\bcold brew\b/, /\bkeurig\b/,
      /\bnespresso\b/, /\bsingle-? ?serve brewers?\b/, /\bfrench press(es)?\b/, /\bmilk frothers?\b/, /\bpercolators?\b/,
    ],
  },
  kettle: { include: [/\bkettles?\b/, /\bwater boilers?\b/, /\bhot water dispensers?\b/] },
  ice_cream_frozen_drink: {
    include: [
      /\bice cream makers?\b/, /\bfrozen (drink|dessert|treat|yogurt) makers?\b/, /\bslush(ie|y)? makers?\b/,
      /\bsoft[- ]serve\b/, /\bcreami\b/, /\bice makers?\b/, /\bshaved ice\b/, /\bsnow ?cone makers?\b/,
    ],
  },
  vacuum: {
    include: [/\bvacuums?\b/, /\bvacuum cleaners?\b/, /\brobot(ic)? (vacuum|mop|cleaner)s?\b/, /\bstick vac/, /\bwet[\/ -]dry vac/, /\bsteam mops?\b/, /\bcarpet cleaners?\b/, /\broomba\b/],
    exclude: [/\b(leaf|lawn|blower)[- /]?(and lawn )?vac/, /\bvacuum[- ]insulated\b/, /\bvacuum[- ]sealed\b/, /\bvacuum sealers?\b/, /\bvacuum (bottle|flask|tumbler|cup|mug|pump|tube|hose)s?\b/],
  },
  hair_care: {
    include: [
      /\bhair ?dryers?\b/, /\bblow ?dryers?\b/, /\bhair straighteners?\b/, /\bflat irons?\b/, /\bcurling (iron|wand)s?\b/,
      /\bhair stylers?\b/, /\bhot air brush(es)?\b/, /\bstraightening brush(es)?\b/, /\bhot brush(es)?\b/, /\bairwrap\b/,
      /\bhair (curler|clipper|trimmer)s?\b/, /\bhot rollers?\b/,
    ],
  },
  fan_heater_air: {
    include: [
      /\bfans?\b/, /\bspace heaters?\b/, /\bportable heaters?\b/, /\bheaters?\b/, /\bair purifiers?\b/, /\bair cleaners?\b/,
      /\bhumidifiers?\b/, /\bdehumidifiers?\b/, /\bdiffusers?\b/, /\bportable air conditioners?\b/, /\bevaporative coolers?\b/,
    ],
    exclude: [
      /\bceiling fans?\b/, /\bexhaust fans?\b/, /\b(water|pool|spa|tank|engine|vehicle|block|baseboard|wall) heaters?\b/,
      /\bheater core\b/, /\bfanny\b/, /\bfans? of\b/, /\bdiffusers? (for|lens)\b/, /\bhand warmers?\b/, /\bbath fans?\b/,
      /\bwater heaters?\b/, /\bfurnaces?\b/, /\battic fans?\b/, /\bgable\b/, /\bgarage heaters?\b/, /\bincubators?\b/, /\baquarium heaters?\b/, /\bfan motors?\b/,
    ],
  },
  li_ion_battery_device: {
    include: [
      /\blithium[- ]ion\b/, /\bli-?ion\b/, /\blithium batter/, /\bpower ?banks?\b/, /\bportable (charger|power station)s?\b/,
      /\bbattery packs?\b/, /\be-?bikes?\b/, /\belectric bik/, /\be-?scooters?\b/, /\belectric scooters?\b/, /\bhoverboards?\b/,
      /\bself-balancing scooters?\b/, /\brechargeable batter/, /\bcordless\b/,
    ],
  },
};

// toy / play versions of appliances (toy toasters, play kitchens) are not appliance failures
const GLOBAL_EXCLUDE = /\btoy\b|\btoys\b|\bplay (set|kitchen)s?\b|\bpretend\b/i;

export function classify(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  if (GLOBAL_EXCLUDE.test(t)) return out;
  for (const [id, { include, exclude = [] }] of Object.entries(CATEGORIES)) {
    // strip excluded phrases first so "ceiling fan and portable fan" still matches portable fan
    let s = t;
    for (const re of exclude) s = s.replace(new RegExp(re.source, 'g'), ' ');
    if (include.some((re) => re.test(s))) out.push(id);
  }
  return out;
}

// SharkNinja brands. "Shark" alone is noisy (toys, swimwear) so require appliance context or company name.
const SN_STRONG = /\bshark ?ninja\b|\beuro-?pro\b|\bninja (foodi|creami|blender|kitchen|coffee|air|thirsti|woodfire|slushi|professional|nutri|speedi|crispi|possible|luxe|detect)\b|\bshark (navigator|rotator|vertex|stratos|apex|rocket|ion|iq|ai|flexstyle|hydrovac|cordless|robot|vacuum|steam|hair|air purifier|clean|evopower|wandvac|powerdetect)\b/i;
export function mentionsSharkNinja(text) {
  return SN_STRONG.test(String(text || ''));
}
