// Auto-buy, two toggles (both off until ticked; remembered between launches):
//
//   Popcorn upgrades that pay back in under a minute - every second, buys the popcorn upgrade with the quickest payback
//     (payback.js's estimate: cost / extra popcorn per real second) while it's under 60 s and affordable, then
//     re-checks, since each level costs more.
//   Seed upgrades once Nature's Subsidy is owned - "Upgrades don't spend seeds": every couple of seconds, buys as many
//     levels as your seeds cover of every shop upgrade the game rates as free to buy (its own max-purchase preview
//     costs 0), which is exactly the seed-cost upgrades while Nature's Subsidy is owned.
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
const POS_KEY = 'birbmod_autobuy_pos';

const um = game.upgradeManager;
const proto = Object.getPrototypeOf(um);

let settings = { popcorn: false, seeds: false };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
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

// ---- panel ----

const panel = document.createElement('div');
panel.id = 'birbmod-autobuy';
Object.assign(panel.style, {
    position: 'fixed', zIndex: 99999, padding: '6px 8px 7px', minWidth: '250px',
    background: 'rgba(14, 17, 27, 0.92)', border: '2px solid #333c57', borderRadius: '4px',
    color: '#e5e7eb', font: '12px Galmuri11, monospace', userSelect: 'none', boxShadow: '0 4px 14px rgba(0,0,0,.5)',
});
let pos = { left: 200, top: 340 };
try { pos = JSON.parse(localStorage.getItem(POS_KEY)) || pos; } catch (e) { /* default */ }
panel.style.left = `${pos.left}px`;
panel.style.top = `${pos.top}px`;
panel.innerHTML = `
    <div data-role="title" style="cursor:move;color:#94a3b8;margin-bottom:4px">Auto-buy</div>
    <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
        <input type="checkbox" data-opt="popcorn"> Popcorn upgrades, payback &lt; 1 min
    </label>
    <label style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-top:3px">
        <input type="checkbox" data-opt="seeds"> Seed upgrades <span data-role="seedNote" style="color:#64748b"></span>
    </label>`;
document.body.appendChild(panel);
mod.onUnload(() => panel.remove());

for (const box of panel.querySelectorAll('[data-opt]')) {
    box.checked = !!settings[box.dataset.opt];
    box.addEventListener('change', () => {
        settings[box.dataset.opt] = box.checked;
        save();
        mod.log(`auto-buy ${box.dataset.opt} ${box.checked ? 'on' : 'off'}`);
    });
}
const seedNote = panel.querySelector('[data-role=seedNote]');
function renderNote() {
    seedNote.textContent = game.hasSunflowerUpgrade(FREE_SEEDS) ? '(free)' : "(needs Nature's Subsidy)";
}

for (const type of ['mousedown', 'mouseup', 'click', 'wheel', 'pointerdown', 'pointerup'])
    panel.addEventListener(type, e => e.stopPropagation());

const title = panel.querySelector('[data-role=title]');
title.addEventListener('mousedown', e => {
    const dx = e.clientX - panel.offsetLeft, dy = e.clientY - panel.offsetTop;
    const move = ev => {
        panel.style.left = `${Math.max(0, ev.clientX - dx)}px`;
        panel.style.top = `${Math.max(0, ev.clientY - dy)}px`;
    };
    const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })); } catch (err) { /* fine */ }
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
});

// ---- run ----

let tick = 0;
const timer = setInterval(() => {
    tick++;
    try { buyPopcorn(); } catch (e) { mod.log(`popcorn auto-buy error: ${(e && e.stack) || e}`); }
    if (tick % 2 === 0) {
        try { buySeeds(); } catch (e) { mod.log(`seed auto-buy error: ${(e && e.stack) || e}`); }
        renderNote();
    }
}, 1000);
mod.onUnload(() => clearInterval(timer));
renderNote();
mod.log(`auto-buy running (popcorn ${settings.popcorn ? 'on' : 'off'}, seeds ${settings.seeds ? 'on' : 'off'})`);
