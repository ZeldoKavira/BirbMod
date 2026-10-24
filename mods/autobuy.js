// Auto-buy, two toggles on Settings > Mods (both off until turned on; remembered between launches):
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

let settings = { popcorn: false, seeds: false, golden: 'off', silo: false, field: false, desert: false };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
if (typeof settings.golden !== 'string') settings.golden = settings.golden ? 'payback' : 'off';
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
// Every unlocked upgrade of the tree you can afford, in whatever it costs (seeds - free with Nature's Subsidy -, twigs,
// fish, spirit trash...). The game's own purchase checks max level, parents, unlock requirements and the cost, and
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

const sunflowerName = id => {
    const key = `sunflowerUpgrades.${id}.name`;
    try { const t = typeof window.t === 'function' ? window.t(key) : null; if (t && t !== key) return t; } catch (e) { /* fall back */ }
    return id.replace(/^d_(desert_)?/, '').replace(/_/g, ' ');
};

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

function buySunflowers() {
    if (settings.field) buySunflowerTree(FIELD_IDS, 'sunflower field');
    if (settings.desert) buySunflowerTree(DESERT_IDS, 'desert field');
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
mod.setting({
    id: 'field', section: 'Auto-buy', label: 'Sunflower Field upgrades', type: 'toggle',
    get: () => settings.field,
    set: v => { settings.field = !!v; save(); mod.log(`auto-buy sunflower field ${settings.field ? 'on' : 'off'}`); },
    note: 'Every unlocked one you can afford, whatever it costs.',
});
mod.setting({
    id: 'desert', section: 'Auto-buy', label: 'Desert Sunflower Field upgrades', type: 'toggle',
    get: () => settings.desert,
    set: v => { settings.desert = !!v; save(); mod.log(`auto-buy desert field ${settings.desert ? 'on' : 'off'}`); },
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
