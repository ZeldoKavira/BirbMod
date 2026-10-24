// Auto-buy options on Settings > Mods (all off until turned on; remembered between launches):
//
//   Popcorn upgrades that pay back in under a minute - every second, buys the popcorn upgrade with the quickest payback
//     (payback.js's estimate: cost / extra popcorn per real second) while it's under 60 s and affordable, then
//     re-checks, since each level costs more.
//   Seed upgrades once Nature's Subsidy is owned - "Upgrades don't spend seeds": every couple of seconds, buys as many
//     levels as your seeds cover of every shop upgrade the game rates as free to buy (its own max-purchase preview
//     costs 0), which is exactly the seed-cost upgrades while Nature's Subsidy is owned.
//
//   Golden popcorn - Golden Popcorn Value by payback or whenever affordable, and Auric Silo whenever affordable
//     (see below).
//   Sunflower Field and Desert Sunflower Field - every unlocked upgrade of that tree you can afford (see below).
//
// Purchases go through the game's own upgrade manager, so its rules (requirements, max levels) all apply.

const PAYBACK_LIMIT = 60;
const MAX_BUYS_PER_TICK = 25;
const FREE_SEEDS = 'd_free_seeds';
const SHOP_IDS = [
    'p_value', 'p_golden_popcorn_value', 'p_speed', 'p_capacity', 'p_move_speed', 'p_auric_silo',
    'pr_popcorn_mult', 'pr_radius_mult', 'pr_respawn_mult', 'pr_golden_popcorn_mult',
    's_more_popcorn', 's_more_feathers', 's_more_seeds',
    't_more_popcorn', 't_more_rebirths', 't_more_seeds', 't_autoclicker', 't_forest_capacity', 't_more_twigs',
    't_auto_popcorn', 't_auto_prestige', 't_auto_seeds',
    'm_ore_cap', 'm_ore_respawn', 'm_ore_value', 'm_more_ores', 'm_speed_ores',
];
const KEY = 'birbmod_autobuy';

const um = game.upgradeManager;
const proto = Object.getPrototypeOf(um);

let settings = { popcorn: false, seeds: false, golden: 'off', silo: false, field: 'off', desert: 'off', picked: [] };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
if (typeof settings.golden !== 'string') settings.golden = settings.golden ? 'payback' : 'off';
for (const tree of ['field', 'desert'])
    if (typeof settings[tree] !== 'string') settings[tree] = settings[tree] ? 'all' : 'off';
if (!Array.isArray(settings.picked)) settings.picked = [];
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not saved */ } };

const level = id => proto.getUpgradeLevel.call(um, id);

function refreshUi() {
    try { game.invalidateUpgradeTreeCache(); } catch (e) { /* older build */ }
    try { game.updateCurrencyHUD(); game.updateUpgradeTree(); } catch (e) { /* UI catches up on its own */ }
}

// ---- popcorn: quickest payback first, while under a minute ----

let boughtPopcorn = 0, lastPopcornLog = 0;
function buyPopcorn() {
    const pb = window.BirbMod.payback;
    if (!settings.popcorn || !pb) return;
    const skip = new Set();
    let bought = 0;
    for (let i = 0; i < MAX_BUYS_PER_TICK; i++) {
        let best = null;
        for (const id of pb.ids) {
            if (skip.has(id)) continue;
            const est = pb.estimate(id);
            if (est && est.seconds < PAYBACK_LIMIT && (!best || est.seconds < best.est.seconds)) best = { id, est };
        }
        if (!best) break;
        const before = level(best.id);
        um.purchaseUpgrade(best.id, true, true);
        if (level(best.id) > before) bought++;
        else skip.add(best.id); // can't afford it (or blocked): try the next best
    }
    if (bought > 0) {
        boughtPopcorn += bought;
        refreshUi();
    }
    if (boughtPopcorn > 0 && performance.now() - lastPopcornLog > 60000) {
        mod.log(`bought ${boughtPopcorn} popcorn upgrade levels with payback under ${PAYBACK_LIMIT} s`);
        boughtPopcorn = 0;
        lastPopcornLog = performance.now();
    }
}

// ---- seeds: everything free to buy while Nature's Subsidy is owned ----

// Whether buying this upgrade now costs nothing: the game's preview totals 0 for seed-cost upgrades under Nature's
// Subsidy. Other currencies are hidden from the preview so only seed purchases can come out at 0.
function freeLevels(id) {
    um.getCurrency = function (currency) { return currency === 'sunflowerSeeds' ? proto.getCurrency.call(um, currency) : 0; };
    try {
        const p = um.calculateMaxUpgradePreview(id);
        if (!p || !(p.levelsGained > 0)) return 0;
        const cost = typeof p.totalCost === 'number' ? p.totalCost : Number(p.totalCost);
        return cost === 0 ? p.levelsGained : 0;
    } catch (e) {
        return 0;
    } finally {
        delete um.getCurrency;
    }
}

let boughtSeeds = 0, lastSeedLog = 0;
function buySeeds() {
    if (!settings.seeds || !game.hasSunflowerUpgrade(FREE_SEEDS)) return;
    const ids = new Set([...SHOP_IDS, ...Object.keys(game.state.upgrades || {}).filter(id => !id.startsWith('d_'))]);
    let bought = 0;
    for (const id of ids) {
        if (freeLevels(id) <= 0) continue;
        const before = level(id);
        um.purchaseUpgradeMax(id, true, true);
        bought += Math.max(0, level(id) - before);
    }
    if (bought > 0) {
        boughtSeeds += bought;
        refreshUi();
    }
    if (boughtSeeds > 0 && performance.now() - lastSeedLog > 60000) {
        mod.log(`bought ${boughtSeeds} seed upgrade levels (free with Nature's Subsidy)`);
        boughtSeeds = 0;
        lastSeedLog = performance.now();
    }
}

// ---- golden popcorn ----
// Golden Popcorn Value: off, "payback < 1 min" (its next level's cost over the extra golden popcorn per real second:
// golden income x how much more each drop gives, from the game's own per-drop formula at both levels), or
// "when affordable" (as many levels as your golden popcorn covers).
// Auric Silo is paid in golden popcorn but raises the regular popcorn cap, so it has no golden payback: its own
// toggle buys it whenever affordable.

const GOLDEN_VALUE = 'p_golden_popcorn_value';
const SILO = 'p_auric_silo';

function goldenCostOfNext(id) {
    const l = level(id);
    if (l >= proto.getUpgradeMaxLevel.call(um, id)) return NaN;
    um.getUpgradeMaxLevel = function (x) { return x === id ? l + 1 : proto.getUpgradeMaxLevel.call(um, x); };
    um.getCurrency = function (c) { return c === 'goldenPopcorn' ? 1e300 : 0; };
    try {
        const p = um.calculateMaxUpgradePreview(id);
        return p ? Number(p.totalCost) : NaN; // NaN: not a golden-popcorn upgrade (or locked)
    } finally {
        delete um.getUpgradeMaxLevel;
        delete um.getCurrency;
    }
}

function perDropAt(lv) {
    um.getUpgradeLevel = function (x) { return x === GOLDEN_VALUE ? lv : proto.getUpgradeLevel.call(um, x); };
    try { return Number(game.calculateGoldenPopcornGainPerDrop()); }
    finally { delete um.getUpgradeLevel; }
}

function goldenValueEstimate() {
    const cost = goldenCostOfNext(GOLDEN_VALUE);
    if (!(cost > 0)) return null;
    const l = level(GOLDEN_VALUE), now = perDropAt(l), next = perDropAt(l + 1);
    // The game's golden rate is per simulated second (3-minute average); make it per real second.
    const speed = Math.max(0.25, Math.min(10, Number(game.debugGameSpeedMultiplier) || 1));
    const income = Number(game.currencyRates && game.currencyRates.goldenpopcorn) * speed;
    const extra = now > 0 && next > now ? income * (next / now - 1) : 0;
    return extra > 0 ? { cost, extra, seconds: cost / extra } : null;
}

let boughtGolden = 0, lastGoldenLog = 0;
function buyGolden() {
    let bought = 0;
    if (settings.golden === 'payback') {
        for (let i = 0; i < MAX_BUYS_PER_TICK; i++) {
            const est = goldenValueEstimate();
            if (!est || est.seconds >= PAYBACK_LIMIT) break;
            const before = level(GOLDEN_VALUE);
            um.purchaseUpgrade(GOLDEN_VALUE, true, true);
            if (level(GOLDEN_VALUE) === before) break; // can't afford it yet
            bought++;
        }
    } else if (settings.golden === 'always' && goldenCostOfNext(GOLDEN_VALUE) > 0) {
        const before = level(GOLDEN_VALUE);
        um.purchaseUpgradeMax(GOLDEN_VALUE, true, true);
        bought += Math.max(0, level(GOLDEN_VALUE) - before);
    }
    if (settings.silo && goldenCostOfNext(SILO) > 0) {
        const before = level(SILO);
        um.purchaseUpgradeMax(SILO, true, true);
        bought += Math.max(0, level(SILO) - before);
    }
    if (bought > 0) {
        boughtGolden += bought;
        refreshUi();
    }
    if (boughtGolden > 0 && performance.now() - lastGoldenLog > 60000) {
        mod.log(`bought ${boughtGolden} golden popcorn upgrade levels`);
        boughtGolden = 0;
        lastGoldenLog = performance.now();
    }
}

// ---- sunflower field trees ----
// Per tree: off, all, or only the marked upgrades (right-click them in the field, or tick them on the "Choose
// sunflower upgrades" page). Buys every unlocked one of
// those you can afford, in whatever it costs (seeds - free with Nature's Subsidy -, twigs, fish, spirit trash...). The game's own purchase checks max level, parents, unlock requirements and the cost, and
// buys silently (no click sound or pop-ups). Passes repeat while something was bought, so children unlocked by a
// purchase get bought too. Each purchase is logged by name.

const FIELD_IDS = [
    'd_sunflower_machine', 'd_unlock_desert_tree', 'd_seed_feeder', 'd_seed_multiplier', 'd_rebirth_playtime',
    'd_golden_harvest', 'd_unlock_evolve', 'd_seed_synergy', 'd_butter_bonanza', 'd_sparrow_snacks',
    'd_rainbow_aura', 'd_cheese_powder', 'd_fishing_luck', 'd_fast_reeling', 'd_seagull_synergy', 'd_popcorn_cap',
    'd_swift_wings', 'd_auto_gen', 'd_faster_seeds', 'd_pickup_range', 'd_seed_multiplier_unlocker',
    'd_seed_pipeline', 'd_pop_max_lvl', 'd_auto_fishing', 'd_seagull_xp', 'd_fish_seeds', 'd_seed_market',
    'd_trophy_bonus', 'd_golden_rain', 'd_prism_shine', 'd_platinum_wings', 'd_deep_dive', 'd_fish_frenzy',
    'd_sparrow_legacy', 'd_sparrow_xp_2', 'd_free_seeds', 'd_unlock_rod_ancient', 'd_unlock_rod_divine',
    'd_unlock_rod_celestial', 'd_sparrow_drain_power', 'd_sparrow_mitosis', 'd_double_catch', 'd_double_fish_buff',
    'd_treasure_map', 'd_treasure_appraisal', 'd_fish_value', 'd_rod_chance', 'd_critical_reel', 'd_xp_tome',
    'd_bulk_bonus', 'd_profit_surge', 'd_treasure_seeker', 'd_shiny_scale', 'd_junk_repurpose', 'd_seed_bag',
    'd_sparrow_hoard', 'd_wing_mastery_plus', 'd_silo_mastery_plus', 'd_butter_hose', 'd_focus_training',
    'd_quantum_corn', 'd_kernel_polish', 'd_sparrow_wisdom', 'd_sparrow_lineage', 'd_twig_popcorn_boost',
    'd_unlock_more_twigs', 'd_forest_bounty', 'd_woodland_resonance', 'd_forest_tree_damage',
    'd_forest_chain_chop_plus', 'd_forest_max_trees', 'd_sparrow_rebirb_preserve', 'd_golden_twig',
    'd_golden_twig_2', 'd_feathered_help', 'd_feathered_synergy', 'd_aurelian_resonance', 'd_flock_synchrony',
    'd_abyssal_light', 'd_net_mastery', 'd_amber_alchemy', 'd_leviathan_mastery', 'd_ocean_bounty',
    'd_gravity_field', 'd_golden_butter', 'd_crit_pop', 'd_void_silo', 'd_hyper_metabolism', 'd_hive_mind',
    'd_phoenix_down', 'd_seed_bank', 'd_mecha_birb', 'd_ancestral_radio', 'd_lunar_compass', 'd_legend_beacon',
    'd_migration_amplifier', 'd_gull_sonar', 'd_rare_routes', 'd_echo_vectors', 'd_fleet_training',
    'd_frenzy_reactor', 'd_cold_start', 'd_patrol_network', 'd_spirit_scouting', 'd_spirit_shell',
    'd_spirit_momentum'
];
const DESERT_IDS = [
    'd_desert_core_mockup', 'd_desert_quest_merchant', 'd_desert_fever', 'd_desert_expedition_points',
    'd_desert_golden_popcorn_chance_2', 'd_desert_golden_popcorn_chance_3', 'd_desert_golden_popcorn_gain_2',
    'd_desert_popcorn_spawn_rate', 'd_desert_bloom_netting', 'd_desert_blossom_route', 'd_desert_bloom_reservoir',
    'd_desert_aura_trail', 'd_desert_dune_scouts', 'd_desert_gourmet_golden_popcorn', 'd_desert_bountiful_harvest',
    'd_desert_feathered_harvest', 'd_desert_golden_popcorn_chance_5', 'd_desert_combat_regen_penalty',
    'd_desert_golden_popcorn_chance_4', 'd_desert_dave_golden_xp', 'd_desert_dave_popcorn_xp',
    'd_desert_seed_generation_x5', 'd_desert_auto_potion', 'd_desert_shiny_enemies',
    'd_desert_golden_popcorn_chance', 'd_desert_seed_generation_x2', 'd_desert_rebirb_golden_feathers',
    'd_desert_rebirb_parrot_vitality', 'd_desert_field_notes', 'd_desert_scout_gull', 'd_desert_tackle_crate',
    'd_desert_guarded_plumage', 'd_desert_salvage_rights', 'd_desert_signal_smoke', 'd_desert_auric_bargain',
    'd_desert_collared_dove', 'd_desert_golden_popcorn_mult_unlock', 'd_desert_seed_generation_x2_plus',
    'd_desert_auric_blueprints', 'd_desert_oasis_recovery', 'd_desert_popcorn_gain_x2', 'd_desert_warpath',
    'd_desert_field_notes_plus', 'd_desert_muad_birb', 'd_desert_sandstorm', 'd_desert_golden_popcorn_x2'
];

const SUNFLOWER_NAMES = {
    d_sunflower_machine: "SUNFLOWER VENDING",
    d_unlock_desert_tree: "UNLOCK THE DESERT TREE",
    d_desert_core_mockup: "DESERT CORE",
    d_desert_quest_merchant: "Quest Merchant",
    d_desert_fever: "DESERT FEVER",
    d_desert_expedition_points: "DESERT CAMPAIGN",
    d_desert_golden_popcorn_chance_2: "SUNKISSED KERNELS",
    d_desert_golden_popcorn_chance_3: "MIRAGE KERNELS",
    d_desert_golden_popcorn_gain_2: "GOLD RUSH",
    d_desert_popcorn_spawn_rate: "DUNE BLOOM",
    d_desert_bloom_netting: "BLOOM NETTING",
    d_desert_blossom_route: "BLOSSOM ROUTE",
    d_desert_bloom_reservoir: "BLOOM RESERVOIR",
    d_desert_aura_trail: "AURA TRAIL",
    d_desert_dune_scouts: "DUNE SCOUTS",
    d_desert_gourmet_golden_popcorn: "GOURMET GOLDEN POPCORN",
    d_desert_bountiful_harvest: "BOUNTIFUL HARVEST",
    d_desert_feathered_harvest: "FEATHERED HARVEST",
    d_desert_golden_popcorn_chance_5: "GILDED DUNES",
    d_desert_combat_regen_penalty: "DUNE VIGOR",
    d_desert_golden_popcorn_chance_4: "AURIC GLINT",
    d_desert_dave_golden_xp: "GILDED LESSONS",
    d_desert_dave_popcorn_xp: "STEADY PECKING",
    d_desert_seed_generation_x5: "DUNE FERTILIZER",
    d_desert_auto_potion: "EMERGENCY FLASK",
    d_desert_shiny_enemies: "AURIC ADVERSARIES",
    d_seed_feeder: "SEED FEEDER",
    d_seed_multiplier: "SEED FERTILIZER",
    d_rebirth_playtime: "TIME IS MONEY",
    d_golden_harvest: "GOLDEN HARVEST",
    d_unlock_evolve: "UNLOCKS EVOLVE",
    d_seed_synergy: "SEED SYNERGY",
    d_butter_bonanza: "BUTTER BONANZA",
    d_sparrow_snacks: "GOURMET SNACKS",
    d_rainbow_aura: "RAINBOW AURA",
    d_cheese_powder: "CHEESE FACTORY",
    d_fishing_luck: "ANGLER'S BLESSING",
    d_fast_reeling: "FAST REELING",
    d_seagull_synergy: "SEAGULL SYNERGY",
    d_popcorn_cap: "POPCORN SILO",
    d_swift_wings: "SWIFT WINGS",
    d_auto_gen: "AUTO GENERATOR",
    d_faster_seeds: "EFFICIENT FARMING",
    d_pickup_range: "VACUUM",
    d_seed_multiplier_unlocker: "SEED MASTERY",
    d_seed_pipeline: "SEED PIPELINE",
    d_pop_max_lvl: "LIMIT BREAKER",
    d_auto_fishing: "AUTO FISHING",
    d_seagull_xp: "SEAGULL TRAINING",
    d_fish_seeds: "FISH SEEDS",
    d_seed_market: "MONETA STORE",
    d_trophy_bonus: "TROPHY BONUS",
    d_golden_rain: "GOLDEN CASCADE",
    d_prism_shine: "PRISM SHINE",
    d_platinum_wings: "PLATINUM WINGS",
    d_deep_dive: "DEEP DIVE",
    d_fish_frenzy: "FISH FRENZY",
    d_sparrow_legacy: "SPARROW LEGACY",
    d_sparrow_xp_2: "BIRD BRAIN",
    d_free_seeds: "NATURE'S SUBSIDY",
    d_unlock_rod_ancient: "ANCIENT JUNGLE",
    d_unlock_rod_divine: "DIVINE",
    d_unlock_rod_celestial: "BANANA",
    d_sparrow_drain_power: "SPARROW RESONANCE",
    d_sparrow_mitosis: "SPARROW MITOSIS",
    d_double_catch: "DOUBLE CATCH",
    d_double_fish_buff: "EXTRA STOMACH",
    d_treasure_map: "MONETA CURRENT",
    d_treasure_appraisal: "MONETA LEDGER",
    d_fish_value: "MARKET BOOM",
    d_rod_chance: "PRECISION CAST",
    d_critical_reel: "CRITICAL CAST",
    d_xp_tome: "EXPERT ANGLER",
    d_bulk_bonus: "WHOLESALE",
    d_profit_surge: "GOLDEN SALE",
    d_treasure_seeker: "MONETA MASTERY",
    d_shiny_scale: "PRISMATIC BADGE",
    d_junk_repurpose: "COMPOST",
    d_seed_bag: "FERTILE SOIL",
    d_sparrow_hoard: "CARRIER PIGEON",
    d_wing_mastery_plus: "WING MASTERY",
    d_silo_mastery_plus: "SILO MASTERY",
    d_butter_hose: "BUTTER HOSE",
    d_focus_training: "FOCUS TRAINING",
    d_quantum_corn: "QUANTUM CORN",
    d_kernel_polish: "KERNEL POLISH",
    d_sparrow_wisdom: "SPARROW WISDOM",
    d_sparrow_lineage: "ANCESTRAL LINEAGE",
    d_twig_popcorn_boost: "TWIG SYNERGY",
    d_unlock_more_twigs: "TWIG MASTERY",
    d_forest_bounty: "FOREST BOUNTY",
    d_woodland_resonance: "WOODLAND RESONANCE",
    d_forest_tree_damage: "SHARPENED CLAWS",
    d_forest_chain_chop_plus: "CHAIN CHOP PLUS",
    d_forest_max_trees: "FOREST EXPANSION",
    d_sparrow_rebirb_preserve: "REBIRB PRESERVE",
    d_golden_twig: "GOLDEN TWIG",
    d_golden_twig_2: "GLORIOUS TWIGS",
    d_feathered_help: "FEATHERED HELP",
    d_feathered_synergy: "SPARROW COLLABORATION",
    d_aurelian_resonance: "AURELIAN RESONANCE",
    d_flock_synchrony: "FLOCK SYNCHRONY",
    d_abyssal_light: "ABYSSAL LIGHT",
    d_net_mastery: "NET MASTERY",
    d_amber_alchemy: "AMBER CURRENT",
    d_leviathan_mastery: "LEVIATHAN MASTERY",
    d_ocean_bounty: "OCEAN'S BOUNTY",
    d_gravity_field: "GRAVITY FIELD",
    d_golden_butter: "GOLDEN BUTTER",
    d_crit_pop: "CRITICAL POP",
    d_void_silo: "VOID SILO",
    d_hyper_metabolism: "HYPER METABOLISM",
    d_hive_mind: "NEURAL OVERCLOCK",
    d_phoenix_down: "PHOENIX DOWN",
    d_seed_bank: "SEED BANK",
    d_mecha_birb: "MECHA-BIRB",
    d_ancestral_radio: "ANCESTRAL RADIO",
    d_lunar_compass: "LUNAR COMPASS",
    d_legend_beacon: "LEGEND BEACON",
    d_migration_amplifier: "SEAGULL REBIRB AMPLIFIER",
    d_gull_sonar: "GULL SONAR",
    d_rare_routes: "RARE ROUTES",
    d_echo_vectors: "ECHO VECTORS",
    d_fleet_training: "FLEET TRAINING",
    d_frenzy_reactor: "FRENZY REACTOR",
    d_cold_start: "COLD START",
    d_patrol_network: "PATROL NETWORK",
    d_desert_golden_popcorn_chance: "GILDED KERNELS",
    d_desert_seed_generation_x2: "SUNSPROUT IRRIGATION",
    d_desert_rebirb_golden_feathers: "REBIRB MANIPULATION",
    d_desert_rebirb_parrot_vitality: "VITAL PLUMAGE",
    d_desert_field_notes: "FIELD NOTES",
    d_desert_scout_gull: "SCOUT GULL",
    d_desert_tackle_crate: "TACKLE CRATE",
    d_desert_guarded_plumage: "GUARDED PLUMAGE",
    d_desert_salvage_rights: "SALVAGE RIGHTS",
    d_desert_signal_smoke: "SIGNAL SMOKE",
    d_desert_auric_bargain: "AURIC BARGAIN",
    d_desert_collared_dove: "DAVE",
    d_desert_golden_popcorn_mult_unlock: "GILDED CATALYST",
    d_desert_seed_generation_x2_plus: "DUNE FERTILITY",
    d_desert_auric_blueprints: "AURIC BLUEPRINTS",
    d_desert_oasis_recovery: "OASIS RECOVERY",
    d_desert_popcorn_gain_x2: "SANDSTORM HARVEST",
    d_desert_warpath: "DUNE WARPATH",
    d_desert_field_notes_plus: "GILDED MARGINS",
    d_desert_muad_birb: "MUAD'BIRB",
    d_desert_sandstorm: "SANDSTORM",
    d_desert_golden_popcorn_x2: "TREASURED HARVEST",
    d_spirit_scouting: "SPIRIT SCOUTING",
    d_spirit_shell: "SPIRIT SHELL",
    d_spirit_momentum: "SPIRIT MOMENTUM",
};
const SUNFLOWER_DESCRIPTIONS = {
    d_sunflower_machine: "Unlocks sunflower platform",
    d_unlock_desert_tree: "Use a Legendary Key to unlock a new branch",
    d_desert_core_mockup: "Desert popcorn has 5% chance to spawn as Golden Popcorn",
    d_desert_quest_merchant: "Unlock the quest merchant.",
    d_desert_fever: "Desert popcorn is worth 5x more.",
    d_desert_expedition_points: "+100% Parrot skill points gained in Expedition.",
    d_desert_golden_popcorn_chance_2: "+2.5% Desert Golden Popcorn chance.",
    d_desert_golden_popcorn_chance_3: "+2.5% Desert Golden Popcorn chance.",
    d_desert_golden_popcorn_gain_2: "1.5x Golden Popcorn gained.",
    d_desert_popcorn_spawn_rate: "Seeds boost Golden Popcorn gained.",
    d_desert_bloom_netting: "+15% Desert Popcorn spawn rate.",
    d_desert_blossom_route: "+5% Spirit Aura chance from Expedition Loot.",
    d_desert_bloom_reservoir: "1.35x Golden Popcorn gained.",
    d_desert_aura_trail: "+25% Aura drop chance in Expeditions.",
    d_desert_dune_scouts: "+50% Expedition Loot value.",
    d_desert_gourmet_golden_popcorn: "Golden Popcorn has a 25% chance to be caramelized, granting 2x Golden Popcorn.",
    d_desert_bountiful_harvest: "3x Golden Popcorn, 2x Seeds.",
    d_desert_feathered_harvest: "Golden Feathers boost Golden Popcorn.",
    d_desert_golden_popcorn_chance_5: "+2.5% Golden Popcorn chance.",
    d_desert_combat_regen_penalty: "20% less Parrot combat regen penalty.",
    d_desert_golden_popcorn_chance_4: "+2.5% Desert Golden Popcorn chance.",
    d_desert_dave_golden_xp: "Dave gains 2x XP when collecting Golden Popcorn.",
    d_desert_dave_popcorn_xp: "Dave gains 2x XP when collecting normal Popcorn.",
    d_desert_seed_generation_x5: "Multiply sunflower seed generation by 2.",
    d_desert_auto_potion: "Auto-use expedition potions when HP drops below a set threshold.",
    d_desert_shiny_enemies: "Expedition enemies have a 1% chance to spawn Shiny.",
    d_seed_feeder: "Auto-feed Sparrow using a chosen % of seed income",
    d_seed_multiplier: "Feathers boost seeds",
    d_rebirth_playtime: "Feathers x Playtime",
    d_golden_harvest: "3x Seeds & Feathers",
    d_unlock_evolve: "New Evolutions await",
    d_seed_synergy: "Seeds boost Popcorn",
    d_butter_bonanza: "+50% Butter Popcorn",
    d_sparrow_snacks: "+50% Sparrow XP",
    d_rainbow_aura: "2x Rainbow Popcorn",
    d_cheese_powder: "+50% Cheese Popcorn",
    d_fishing_luck: "+25% Fishing Luck",
    d_fast_reeling: "-25% Reel Time",
    d_seagull_synergy: "Fish XP buff affects Seagull",
    d_popcorn_cap: "x2 Popcorn Cap",
    d_swift_wings: "1.3x bird speed",
    d_auto_gen: "Auto generate seeds",
    d_faster_seeds: "2x Seed Speed",
    d_pickup_range: "1.25x Pickup Range",
    d_seed_multiplier_unlocker: "Unlocks seed upgrade",
    d_seed_pipeline: "+25% Seed Speed",
    d_pop_max_lvl: "+2 Pop. Mult Max Level",
    d_auto_fishing: "Automate fishing",
    d_seagull_xp: "+50% Seagull XP",
    d_fish_seeds: "Unlock fish sales for Seeds; total Fish caught boost Seed production",
    d_seed_market: "Highest Moneta held boosts Seeds from fish sales",
    d_trophy_bonus: "Popcorn x Heaviest Fish Ever Caught",
    d_golden_rain: "Gain 0.1% of your best completed Rebirb per second",
    d_prism_shine: "+25% Popcorn value",
    d_platinum_wings: "+15% movement speed",
    d_deep_dive: "+20% rare fish chance",
    d_fish_frenzy: "-20% fishing cooldown",
    d_sparrow_legacy: "Evolution preserves 25% of Sparrow XP",
    d_sparrow_xp_2: "-25% Seeds to feed / +25% XP gained",
    d_free_seeds: "Upgrades don't spend seeds",
    d_unlock_rod_ancient: "Unlocks Ancient Jungle",
    d_unlock_rod_divine: "Unlocks Divine",
    d_unlock_rod_celestial: "Unlocks Banana",
    d_sparrow_drain_power: "Unlocks Resonance.",
    d_sparrow_mitosis: "Unlocks Mitosis.",
    d_double_catch: "10% chance 2 fish",
    d_double_fish_buff: "Adds one more active fish buff slot",
    d_treasure_map: "+50% Moneta per catch",
    d_treasure_appraisal: "2x Moneta per catch",
    d_fish_value: "Fish sell for 2x",
    d_rod_chance: "+15% relative catch chance for Progression targets",
    d_critical_reel: "10% chance of an instant catch",
    d_xp_tome: "+50% Fishing XP",
    d_bulk_bonus: "+20% Value when using Safe Sell",
    d_profit_surge: "10% Chance for 10x Value",
    d_treasure_seeker: "2x Moneta per catch",
    d_shiny_scale: "+10% final Shiny chance per Highest Rod Tier",
    d_junk_repurpose: "Junk sells for Moneta",
    d_seed_bag: "+50% Global Seed Generation",
    d_sparrow_hoard: "Sparrow collects 5x value",
    d_wing_mastery_plus: "+10 Wing Training Levels",
    d_silo_mastery_plus: "+10 Popcorn Cap Levels",
    d_butter_hose: "x1.5 Popcorn Value",
    d_focus_training: "x1.3 Pickup Radius",
    d_quantum_corn: "x1.2 Spawn Rate",
    d_kernel_polish: "x2 Popcorn Value",
    d_sparrow_wisdom: "+50% Sparrow XP",
    d_sparrow_lineage: "Legacy now preserves 50% of Sparrow XP",
    d_twig_popcorn_boost: "Twigs multiplied by Popcorn",
    d_unlock_more_twigs: "Unlocks twig upgrade",
    d_forest_bounty: "3x Twigs",
    d_woodland_resonance: "Wood boosts Twigs",
    d_forest_tree_damage: "+1 tree damage",
    d_forest_chain_chop_plus: "Chain chop hits one more tree",
    d_forest_max_trees: "+15 Max Trees levels",
    d_sparrow_rebirb_preserve: "Preserve 50% of Sparrow Rebirb multiplier",
    d_golden_twig: "5% Chance for x100 Twigs",
    d_golden_twig_2: "x2 Golden Twig Multiplier",
    d_feathered_help: "Sparrows boost twig value (+1 Base Twig per Sparrow)",
    d_feathered_synergy: "Double Feathered Help Effect",
    d_aurelian_resonance: "Golden Twig multiplier and Chain chance",
    d_flock_synchrony: "Global Twig multiplier scaled by Sparrows",
    d_abyssal_light: "+50% Average Fish Weight",
    d_net_mastery: "Auto-Fisher 10% chance for 2x fish",
    d_amber_alchemy: "20% chance to gain 100x fish value in Seeds",
    d_leviathan_mastery: "Fish Value scales with Weight squared",
    d_ocean_bounty: "Catching fish grants Seeds",
    d_gravity_field: "Passive Popcorn Pull (Weak)",
    d_golden_butter: "Popcorn Value scales with Golden Feathers",
    d_crit_pop: "1% Chance for Red Popcorn (100x)",
    d_void_silo: "+10% Total Popcorn Capacity",
    d_hyper_metabolism: "Popcorn grants stacking speed buff",
    d_hive_mind: "Sparrow Speed Limit increased by 50%",
    d_phoenix_down: "Sparrows keep XP on Evolution",
    d_seed_bank: "+0.0167%/s of current Seeds (5T soft cap)",
    d_mecha_birb: "Sparrows collect 2x Popcorn",
    d_ancestral_radio: "Seagull -> Sparrow XP share 10%",
    d_lunar_compass: "+35% weight for Seagull catches",
    d_legend_beacon: "Daily legendary cooldown 24h->16h, daily shiny 1%->3%",
    d_migration_amplifier: "+5% per level to Seagull Rebirb rare and XP effects only",
    d_gull_sonar: "Seagull rolls twice and keeps the rarer catch",
    d_rare_routes: "+15% rare-up reroll chance on seagull catches",
    d_echo_vectors: "+10% duplicate-catch chance",
    d_fleet_training: "+6% seagull XP per level",
    d_frenzy_reactor: "Frenzy duration x1.5",
    d_cold_start: "Frenzy cooldown x0.65",
    d_patrol_network: "+1% duplicate-catch chance per level",
    d_desert_golden_popcorn_chance: "+2.5% Desert Golden Popcorn chance.",
    d_desert_seed_generation_x2: "Double sunflower seed generation.",
    d_desert_rebirb_golden_feathers: "+100% Golden Feathers gained on Rebirb.",
    d_desert_rebirb_parrot_vitality: "+25% Parrot Vitality gained in Expedition.",
    d_desert_field_notes: "Gain 1 Parrot Skill Point per second, including offline.",
    d_desert_scout_gull: "Send Seagulls to expedition fishing floors.",
    d_desert_tackle_crate: "Dispatched seagull fishes 35% faster and rerolls weak catches.",
    d_desert_guarded_plumage: "+15% Expedition parrot HP.",
    d_desert_salvage_rights: "+25% Expedition Loot value.",
    d_desert_signal_smoke: "1.5x Golden Popcorn gained.",
    d_desert_auric_bargain: "Reduces the price of Golden Popcorn upgrades by 25%.",
    d_desert_collared_dove: "Unlock a desert bird that scavenges popcorn in clustered swoops.",
    d_desert_golden_popcorn_mult_unlock: "Unlock GOLDEN POPCORN MULT in the Rebirb Shop.",
    d_desert_seed_generation_x2_plus: "Double the value of sunflower seeds.",
    d_desert_auric_blueprints: "Unlock AURIC SILO in the Popcorn Shop.",
    d_desert_oasis_recovery: "+10% Health Regen value per level.",
    d_desert_popcorn_gain_x2: "Double Popcorn gained.",
    d_desert_warpath: "+10% Expedition damage per level.",
    d_desert_field_notes_plus: "+33.3% Golden Popcorn gained per level.",
    d_desert_muad_birb: "Golden Popcorn boosts Expedition skill points.",
    d_desert_sandstorm: "A sandstorm can occur on the desert, turning every popcorn into golden",
    d_desert_golden_popcorn_x2: "Double Golden Popcorn gained in Desert.",
    d_spirit_scouting: "+10% Parrot Damage per level",
    d_spirit_shell: "+10% Parrot Max HP per level",
    d_spirit_momentum: "+2% Parrot atk/move speed per level",
};

const sunflowerName = id => SUNFLOWER_NAMES[id] || id.replace(/^d_(desert_)?/, '').replace(/_/g, ' ');

function buySunflowerTree(ids, label) {
    let bought = 0;
    for (let pass = 0; pass < 5; pass++) {
        let thisPass = 0;
        for (const id of ids) {
            let unlocked = false;
            try { unlocked = um.isSunflowerUpgradeUnlocked(id); } catch (e) { unlocked = false; }
            if (!unlocked) continue;
            const before = um.getSunflowerLevel(id);
            try { um.purchaseSunflowerUpgrade(id, true); } catch (e) { mod.log(`${label}: ${id} failed: ${e}`); continue; }
            const after = um.getSunflowerLevel(id);
            if (after > before) {
                thisPass++;
                mod.log(`${label}: bought ${sunflowerName(id)} (${id}) level ${after}`);
            }
        }
        bought += thisPass;
        if (thisPass === 0) break;
    }
    return bought;
}

// Which tree an upgrade belongs to, as the game decides it: the desert view shows d_desert_ and d_spirit_ upgrades,
// the base view everything else except the mine's and the archivist's.
function treeOf(id) {
    if (id.startsWith('d_mine_') || id.startsWith('d_archivist_')) return null;
    return id.startsWith('d_desert_') || id.startsWith('d_spirit_') ? 'desert' : 'field';
}

// All the upgrades of a tree: the game's own field stations, or the built-in lists before the field exists.
function allOfTree(tree) {
    const stations = game.sunflowerUpgradeStations || [];
    const ids = [...new Set(stations.map(st => st.id))].filter(id => treeOf(id) === tree);
    return ids.length ? ids : tree === 'desert' ? DESERT_IDS : FIELD_IDS;
}

function treeIds(tree) {
    const ids = allOfTree(tree);
    const mode = settings[tree];
    if (mode === 'all') return ids;
    if (mode === 'selected') {
        const picked = new Set(settings.picked);
        return ids.filter(id => picked.has(id));
    }
    return [];
}

function buySunflowers() {
    const field = treeIds('field'), desert = treeIds('desert');
    if (field.length) buySunflowerTree(field, 'sunflower field');
    if (desert.length) buySunflowerTree(desert, 'desert field');
}

// ---- marking upgrades on the field itself ----
// Right-click an upgrade in the sunflower field to mark it for auto-buy (again to unmark); marking sets that tree to
// Selected. Marked ones get an "AUTO" badge drawn over the field. The game's own AUTO BUY then also skips unmarked
// upgrades of a tree that's on Selected.

function setPicked(id, on) {
    const set = new Set(settings.picked);
    if (on) set.add(id); else set.delete(id);
    settings.picked = [...set];
    const tree = treeOf(id);
    if (on && tree && settings[tree] !== 'selected') {
        settings[tree] = 'selected';
        mod.log(`${tree} auto-buy set to Selected (an upgrade was marked on the field)`);
    }
    save();
    window.BirbMod.settingsChanged();
}

// The field is on screen while the renderer keeps asking whether its upgrades are visible.
let lastFieldDraw = 0;
const originalVisible = game.renderCtxIsSunflowerUpgradeVisible;
const visibleWrapper = id => { lastFieldDraw = performance.now(); return originalVisible(id); };
if (typeof originalVisible === 'function') {
    game.renderCtxIsSunflowerUpgradeVisible = visibleWrapper;
    mod.onUnload(() => { if (game.renderCtxIsSunflowerUpgradeVisible === visibleWrapper) game.renderCtxIsSunflowerUpgradeVisible = originalVisible; });
}
const onField = () => performance.now() - lastFieldDraw < 300;
const viewTree = () => (game.state.sunflowerTreeView === 'desert' ? 'desert' : 'field');

// Screen <-> world, the game's own mapping (canvas box, logical screen size, zoom, camera).
function screenScale() {
    const c = game.canvas, r = c.getBoundingClientRect(), k = Math.max(1, Number(game.canvasRenderScale || 1));
    const sw = Math.max(1, Number(game.screenWidth || c.width / k)), sh = Math.max(1, Number(game.screenHeight || c.height / k));
    return { r, sx: r.width / sw, sy: r.height / sh };
}
function toWorld(cx, cy) {
    const { r, sx, sy } = screenScale();
    return { x: (cx - r.left) / sx / game.zoom + game.cameraX, y: (cy - r.top) / sy / game.zoom + game.cameraY };
}
function toClient(wx, wy) {
    const { r, sx, sy } = screenScale();
    return { x: r.left + (wx - game.cameraX) * game.zoom * sx, y: r.top + (wy - game.cameraY) * game.zoom * sy, scale: game.zoom * sx };
}

function stationAt(cx, cy) {
    const w = toWorld(cx, cy), tree = viewTree();
    for (const st of game.sunflowerUpgradeStations || []) {
        if (treeOf(st.id) !== tree) continue;
        let visible = false;
        try { visible = game.isSunflowerUpgradeVisible(st.id); } catch (e) { visible = false; }
        if (visible && w.x >= st.x && w.x <= st.x + st.width && w.y >= st.y && w.y <= st.y + st.height) return st;
    }
    return null;
}

const onContextMenu = e => {
    if (!onField()) return;
    const target = e.target;
    if (!target || (target !== game.canvas && target.id !== 'game-area')) return;
    const st = stationAt(e.clientX, e.clientY);
    if (!st) return;
    e.preventDefault();
    e.stopPropagation();
    const on = !settings.picked.includes(st.id);
    setPicked(st.id, on);
    try { game.showFloatText(on ? 'Auto-buy: ON' : 'Auto-buy: OFF', st.x + st.width / 2, st.y - 6, on ? '#22c55e' : '#94a3b8'); } catch (err) { /* cosmetic */ }
    mod.log(`${on ? 'marked' : 'unmarked'} ${sunflowerName(st.id)} (${st.id}) for auto-buy`);
};
window.addEventListener('contextmenu', onContextMenu, true);
mod.onUnload(() => window.removeEventListener('contextmenu', onContextMenu, true));

// AUTO badges over the marked upgrades, following the camera.
const badges = document.createElement('div');
badges.id = 'birbmod-autobuy-badges';
// Just above the game canvas (z-index 10), below every game panel and window (1000s).
Object.assign(badges.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: 11, pointerEvents: 'none' });
document.body.appendChild(badges);
mod.onUnload(() => badges.remove());
const pool = [];
function badge(i) {
    if (!pool[i]) {
        const b = document.createElement('div');
        b.textContent = 'AUTO';
        Object.assign(b.style, {
            position: 'fixed', transform: 'translate(-100%, -40%)', padding: '1px 5px', borderRadius: '4px',
            background: '#16a34a', color: '#fff', font: 'bold 10px Galmuri11, monospace', letterSpacing: '.04em',
            boxShadow: '0 0 0 1px rgba(0,0,0,.45)', whiteSpace: 'nowrap',
        });
        badges.appendChild(b);
        pool[i] = b;
    }
    return pool[i];
}
let frame = 0;
function drawBadges() {
    frame = requestAnimationFrame(drawBadges);
    let n = 0;
    if (onField() && settings.picked.length) {
        const picked = new Set(settings.picked), tree = viewTree();
        for (const st of game.sunflowerUpgradeStations || []) {
            if (!picked.has(st.id) || treeOf(st.id) !== tree) continue;
            let visible = false;
            try { visible = game.isSunflowerUpgradeVisible(st.id); } catch (e) { visible = false; }
            if (!visible) continue;
            const c = toClient(st.x + st.width, st.y);
            const b = badge(n++);
            b.style.left = `${c.x}px`;
            b.style.top = `${c.y}px`;
            b.style.fontSize = `${Math.max(8, Math.min(13, 11 * c.scale))}px`;
            b.style.display = '';
        }
    }
    for (let i = n; i < pool.length; i++) pool[i].style.display = 'none';
}
frame = requestAnimationFrame(drawBadges);
mod.onUnload(() => cancelAnimationFrame(frame));

// The game's own AUTO BUY: in a tree set to Selected, only the marked upgrades.
const adapter = game.nestManager && game.nestManager.game;
const originalAuto = adapter && adapter.purchaseSunflowerUpgradeForAutomation;
if (typeof originalAuto === 'function') {
    const autoWrapper = function (id) {
        const tree = treeOf(String(id));
        if (tree && settings[tree] === 'selected' && !settings.picked.includes(id)) return false;
        return originalAuto.apply(this, arguments);
    };
    adapter.purchaseSunflowerUpgradeForAutomation = autoWrapper;
    mod.onUnload(() => { if (adapter.purchaseSunflowerUpgradeForAutomation === autoWrapper) adapter.purchaseSunflowerUpgradeForAutomation = originalAuto; });
}

// ---- the chooser page ----

let pickTree = 'field', showOwned = false;
function status(id) {
    let level = 0, unlocked = false;
    try { level = um.getSunflowerLevel(id); unlocked = um.isSunflowerUpgradeUnlocked(id); } catch (e) { /* locked */ }
    if (level > 0) return { text: `owned${level > 1 ? ` (lv ${level})` : ''}`, color: '#22c55e', available: unlocked };
    return unlocked ? { text: 'available', color: '#facc15', available: true } : { text: 'locked', color: '#64748b', available: false };
}

function renderPicker(box, redraw) {
    const ids = allOfTree(pickTree);
    const picked = new Set(settings.picked);
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const tab = (tree, label) => `<button type="button" class="birb-btn ${pickTree === tree ? 'primary' : 'secondary'}" data-tree="${tree}"
        style="flex:1; padding:8px; font-size:13px;${pickTree === tree ? '' : 'opacity:.75;'}">${label}</button>`;
    const mode = settings[pickTree];
    const shown = ids.filter(id => showOwned || um.getSunflowerLevel(id) === 0 || picked.has(id));
    const rows = shown.map(id => {
        const st = status(id);
        return `<label style="display:flex;gap:8px;align-items:flex-start;padding:5px 2px;border-bottom:1px solid rgba(148,163,184,.15);cursor:pointer">
            <input type="checkbox" data-pick="${id}" ${picked.has(id) ? 'checked' : ''} style="margin-top:3px">
            <span style="flex:1;min-width:0">
                <span style="font-size:13px">${esc(sunflowerName(id))}</span>
                <span style="font-size:11px;color:${st.color};margin-left:6px">${st.text}</span>
                <span style="display:block;font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(SUNFLOWER_DESCRIPTIONS[id] || '')}</span>
            </span>
        </label>`;
    }).join('');
    box.innerHTML = `
        <div style="display:flex;gap:6px;margin-bottom:8px">${tab('field', 'Sunflower Field')}${tab('desert', 'Desert')}</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:8px">This tree's auto-buy is <b style="color:#e5e7eb">${mode === 'selected' ? 'Selected' : mode === 'all' ? 'All' : 'Off'}</b>${mode === 'selected' ? '' : ' - set it to Selected on the Mods page to buy only the ticked ones'}. ${ids.filter(id => picked.has(id)).length} ticked.</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
            <button type="button" class="birb-btn secondary" data-act="available" style="flex:1;padding:7px;font-size:12px">Tick all available</button>
            <button type="button" class="birb-btn secondary" data-act="clear" style="flex:1;padding:7px;font-size:12px">Clear this tree</button>
        </div>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:#94a3b8;margin-bottom:6px;cursor:pointer">
            <input type="checkbox" data-owned ${showOwned ? 'checked' : ''}> Show owned upgrades (${ids.length - shown.length} hidden)
        </label>
        <div>${rows || '<div style="color:#94a3b8;font-size:12px">Everything in this tree is owned.</div>'}</div>`;
    box.onchange = e => {
        if (e.target.matches('[data-owned]')) { showOwned = e.target.checked; redraw(); return; }
        const box2 = e.target.closest('[data-pick]');
        if (!box2) return;
        const set = new Set(settings.picked);
        if (box2.checked) set.add(box2.dataset.pick); else set.delete(box2.dataset.pick);
        settings.picked = [...set];
        save();
    };
    box.onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.tree) { pickTree = b.dataset.tree; redraw(); return; }
        const set = new Set(settings.picked);
        if (b.dataset.act === 'available') ids.filter(id => status(id).available).forEach(id => set.add(id));
        if (b.dataset.act === 'clear') ids.forEach(id => set.delete(id));
        settings.picked = [...set];
        save();
        redraw();
    };
}

// ---- on the Mods settings page ----

mod.setting({
    id: 'popcorn', section: 'Auto-buy', label: 'Popcorn upgrades, payback < 1 min', type: 'toggle',
    get: () => settings.popcorn,
    set: v => { settings.popcorn = !!v; save(); mod.log(`auto-buy popcorn ${settings.popcorn ? 'on' : 'off'}`); },
});
mod.setting({
    id: 'seeds', section: 'Auto-buy', label: 'Seed upgrades', type: 'toggle',
    get: () => settings.seeds,
    set: v => { settings.seeds = !!v; save(); mod.log(`auto-buy seeds ${settings.seeds ? 'on' : 'off'}`); },
    note: () => (game.hasSunflowerUpgrade(FREE_SEEDS) ? "Free with Nature's Subsidy." : "Waits for Nature's Subsidy (upgrades don't spend seeds)."),
});
const treeChoices = [{ value: 'off', label: 'Off' }, { value: 'all', label: 'All' }, { value: 'selected', label: 'Selected' }];
mod.setting({
    id: 'field', section: 'Auto-buy', label: 'Sunflower Field upgrades', type: 'choice', choices: treeChoices,
    get: () => settings.field,
    set: v => { settings.field = v; save(); mod.log(`auto-buy sunflower field: ${v}`); },
});
mod.setting({
    id: 'desert', section: 'Auto-buy', label: 'Desert Sunflower Field upgrades', type: 'choice', choices: treeChoices,
    get: () => settings.desert,
    set: v => { settings.desert = v; save(); mod.log(`auto-buy desert field: ${v}`); },
    note: 'Buys every unlocked one you can afford, whatever it costs. "Selected" buys only marked ones: right-click an upgrade in the field to mark it (an AUTO badge shows), or tick it below. The game\'s own AUTO BUY follows the marks too.',
});
mod.setting({
    id: 'pick', section: 'Auto-buy', label: 'Choose sunflower upgrades', type: 'page',
    renderPage: renderPicker,
});
mod.setting({
    id: 'golden', section: 'Auto-buy', label: 'Golden Popcorn Value', type: 'choice',
    choices: [{ value: 'off', label: 'Off' }, { value: 'payback', label: 'Payback < 1 min' }, { value: 'always', label: 'When affordable' }],
    get: () => settings.golden,
    set: v => { settings.golden = v; save(); mod.log(`auto-buy golden value: ${settings.golden}`); },
    note: () => {
        const est = goldenValueEstimate();
        return est ? `Next level pays back in about ${Math.round(est.seconds)} s of golden popcorn.` : 'Paid and repaid in golden popcorn.';
    },
});
mod.setting({
    id: 'silo', section: 'Auto-buy', label: 'Auric Silo whenever affordable', type: 'toggle',
    get: () => settings.silo,
    set: v => { settings.silo = !!v; save(); mod.log(`auto-buy auric silo ${settings.silo ? 'on' : 'off'}`); },
    note: 'Raises the popcorn cap; paid in golden popcorn, so it competes with Golden Popcorn Value.',
});

// ---- run ----

let tick = 0;
const timer = setInterval(() => {
    tick++;
    try { buyPopcorn(); } catch (e) { mod.log(`popcorn auto-buy error: ${(e && e.stack) || e}`); }
    try { buyGolden(); } catch (e) { mod.log(`golden auto-buy error: ${(e && e.stack) || e}`); }
    if (tick % 2 === 0) {
        try { buySeeds(); } catch (e) { mod.log(`seed auto-buy error: ${(e && e.stack) || e}`); }
    }
    if (tick % 3 === 0) {
        try { buySunflowers(); } catch (e) { mod.log(`sunflower auto-buy error: ${(e && e.stack) || e}`); }
    }
}, 1000);
mod.onUnload(() => clearInterval(timer));
mod.log(`auto-buy running (popcorn ${settings.popcorn ? 'on' : 'off'}, seeds ${settings.seeds ? 'on' : 'off'})`);
