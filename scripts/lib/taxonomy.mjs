/* Per-category failure-mode taxonomy for the v1 Ninja scope, plus the hazard
   and injury enums. Seeded from the research doc + domain knowledge; tuned
   after the pilot. The extractor must pick one failure_mode from the category's
   list, or return failure_mode:"other" with a short free-text label. */

export const V1_CATEGORIES = [
  "pressure_multi_cooker", "air_fryer", "blender_food_processor", "ice_cream_frozen_drink",
  "coffee_maker", "kettle", "oven_toaster", "grill",
];

export const HAZARD_TYPES = ["burn", "laceration", "fire", "shock", "choking/ingestion", "impact", "other"];
export const INJURY_LEVELS = ["none", "minor", "medical", "serious"];

export const TAXONOMY = {
  pressure_multi_cooker: [
    "lid_opens_under_pressure",
    "lid_interlock_failure",
    "seal_gasket_failure",
    "pressure_release_valve_failure",
    "overpressure_rupture_explosion",
    "hot_contents_eruption",
    "overheat_scorching",
    "electrical_fault_shock",
    "handle_body_breakage",
  ],
  air_fryer: [
    "overheating_fire",
    "smoke_emission",
    "basket_coating_degradation",
    "glass_component_shattering",
    "auto_start_or_wont_turn_off",
    "handle_door_latch_failure",
    "plastic_melting_deformation",
    "electrical_fault_shock",
  ],
  blender_food_processor: [
    "blade_detachment_or_breakage",
    "jar_container_cracking_shattering",
    "lid_failure_contents_ejection",
    "motor_overheat_fire_smoke",
    "coupling_drive_failure",
    "laceration_during_handling_cleaning",
    "unexpected_activation",
    "electrical_fault_shock",
  ],
  ice_cream_frozen_drink: [
    "blade_paddle_breakage",
    "container_bowl_cracking",
    "motor_overheat",
    "pressure_or_contents_ejection",
    "laceration_during_handling",
    "electrical_fault_shock",
  ],
  coffee_maker: [
    "carafe_glass_shattering",
    "hot_liquid_or_steam_ejection",
    "overheating_fire_smoke",
    "scald_during_normal_use",
    "leak_water_into_electrics",
    "pressure_valve_failure",
    "electrical_fault_shock",
  ],
  kettle: [
    "scald_from_hot_water",
    "lid_failure_or_ejection",
    "auto_shutoff_failure",
    "overheating_fire",
    "leak_water_into_electrics",
    "base_connector_fault",
    "electrical_fault_shock",
  ],
  oven_toaster: [
    "overheating_fire",
    "failure_to_shut_off",
    "door_glass_shattering",
    "smoke_emission",
    "crumb_tray_or_food_fire",
    "plastic_melting_deformation",
    "electrical_fault_shock",
  ],
  grill: [
    "fire_or_flare_up",
    "grease_fire",
    "overheating_or_runaway_heating",
    "burn_on_hot_surface",
    "electrical_fault_shock",
    "gas_leak_or_malfunction",
    "tip_over_instability",
  ],
};

// Likely IEC/UL 60335 part per category, phrased for the app as "check against".
// Never asserts compliance.
export const STANDARD_HINT = {
  pressure_multi_cooker: "IEC/UL 60335-2-15 (appliances for heating liquids)",
  air_fryer: "IEC/UL 60335-2-9 (grills, toasters and similar portable cooking appliances)",
  blender_food_processor: "IEC/UL 60335-2-14 (kitchen machines)",
  ice_cream_frozen_drink: "IEC/UL 60335-2-24 (refrigerating appliances / ice makers)",
  coffee_maker: "IEC/UL 60335-2-15 (appliances for heating liquids)",
  kettle: "IEC/UL 60335-2-15 (appliances for heating liquids)",
  oven_toaster: "IEC/UL 60335-2-9 (grills, toasters and similar portable cooking appliances)",
  grill: "IEC/UL 60335-2-9 (grills and similar) / 60335-2-78 (outdoor grills)",
};

export function failureModesFor(cat) { return TAXONOMY[cat] || []; }
