// Payback time on the popcorn upgrades' buy buttons: how long the extra popcorn an upgrade brings takes to repay its
// cost, at your current income.
//
// Income R is popcorn collected per real second over the last 60 s (the game's own figure until there's enough data).
// What an upgrade adds depends on what limits income. f is the share of the last minute the meadow sat full:
//   Popcorn Value    R x (next / current - 1)                  - value multiplies every pickup
//   Faster Popcorns  R x (1 - f) x (interval now / next - 1)   - only helps while spawning is the limit
//   Wing Training    R x f x (speed next / now - 1)            - only helps while collecting is the limit
//   Popcorn Cap      R x f x (sqrt(cap next / now) - 1)        - a denser field means shorter flights between pickups
// These are estimates (marked ~). While MAX is hovered, the game previews the whole purchase on the buy button and
// the label shows that purchase's payback, marked (max).

const UPGRADES = {
    p_value: 'value',
    p_speed: 'speed',
    p_capacity: 'capacity',
    p_move_speed: 'move',
};
const MEADOW = 0;
const WINDOW = 60;

const um = game.upgradeManager;
const protoLevel = Object.getPrototypeOf(um).getUpgradeLevel;

// The upgrade's effect at a given level, without buying it: shadow getUpgradeLevel for this one synchronous call.
function effectAt(id, level) {
    um.getUpgradeLevel = function (x) { return x === id ? level : protoLevel.call(um, x); };
    try { return Number(game.getUpgradeEffect(id)); }
    finally { delete um.getUpgradeLevel; }
}

// The game's number format back to a number ("2,164", "1.235M", "4.000Qa").
const suffixes = {};
for (let k = 2; k < 40; k++) {
    const s = String(game.formatNum(Math.pow(10, 3 * k))).replace(/[\d.,\s]/g, '');
    if (s && !(s in suffixes)) suffixes[s] = 3 * k;
}
function parseAmount(text) {
    const m = /^([\d.,]+)\s*([A-Za-z]*)$/.exec(String(text || '').trim());
    if (!m) return NaN;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!m[2]) return n;
    return m[2] in suffixes ? n * Math.pow(10, suffixes[m[2]]) : NaN;
}

function duration(s) {
    if (!Number.isFinite(s) || s < 0) return null;
    if (s < 1) return '<1s';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
}

function num(v) {
    if (typeof v === 'number') return v;
    if (v && typeof v.toNumber === 'function') return v.toNumber();
    return Number(v) || 0;
}

// ---- income and how often the meadow is full ----

const samples = [];
function sample() {
    let full = false;
    try {
        const list = game.popcornSystem.getPopcorns(MEADOW);
        const cap = game.getMaxPopcorn(MEADOW);
        full = !!list && cap > 0 && list.length >= cap;
    } catch (e) { /* no meadow yet */ }
    samples.push({ t: performance.now() / 1000, total: num(game.state.totalPopcornCollected), full });
    while (samples.length > WINDOW + 1) samples.shift();
}

function income() {
    // The game's figure is per simulated second; payback is in real time, so scale it by the game speed.
    const speed = Math.max(0.25, Math.min(10, Number(game.debugGameSpeedMultiplier) || 1));
    const shown = num(game.currencyRates && game.currencyRates.popcorn) * speed;
    if (samples.length < 11) return { rate: shown, source: "the game's rate" };
    const a = samples[0], b = samples[samples.length - 1];
    const rate = (b.total - a.total) / Math.max(1, b.t - a.t);
    return { rate: rate > 0 ? rate : shown, source: `${Math.round(b.t - a.t)} s of real time` };
}

function fullShare() {
    if (!samples.length) return 0;
    return samples.filter(s => s.full).length / samples.length;
}

// Extra popcorn per second from one more level, and how it was worked out.
// Extra popcorn per second from going from the current level to toLevel.
function gain(id, R, f, toLevel) {
    const level = protoLevel.call(um, id);
    const target = toLevel ?? level + 1;
    const now = effectAt(id, level), next = effectAt(id, target);
    if (!(now > 0) || !(next > 0) || now === next) return 0;
    switch (UPGRADES[id]) {
        case 'value': {
            // The card's own figures (multipliers included), as the card shows them.
            const shown = l => parseAmount(String(game.getShopUpgradeEffectHtml(id, l)).replace(/<[^>]*>/g, ''));
            const a = shown(level), b = shown(target);
            return a > 0 && b > 0 ? R * (b / a - 1) : R * (next / now - 1);
        }
        case 'speed': return R * (1 - f) * (now / next - 1);
        case 'move': return R * f * (next / now - 1);
        case 'capacity': return R * f * (Math.sqrt(next / now) - 1);
    }
    return 0;
}

function fmt(n) {
    return n >= 1000 ? game.formatNum(Math.round(n)) : (Math.round(n * 100) / 100).toString();
}

// ---- buttons ----

const TAG = 'birbmod-payback';
const style = document.createElement('style');
style.textContent = `.${TAG}{display:block;font-size:10px;line-height:1.1;opacity:.85;margin-top:1px;white-space:nowrap;pointer-events:none}`;
document.head.appendChild(style);
mod.onUnload(() => style.remove());

let current = { R: 0, f: 0 };

function compute() {
    current = { R: income().rate, f: fullShare() };
}

// No hover tooltip of our own: the game already uses hover on these cards. Hovering MAX makes the game preview the
// whole purchase on the buy button (total cost, target level), and then the label is that purchase's payback.
function apply() {
    observer.disconnect();
    try {
        for (const node of document.querySelectorAll('.upgrade-node[data-id]')) {
            const id = node.dataset.id;
            if (!(id in UPGRADES)) continue;
            const btn = node.querySelector('button.upgrade-btn-action[data-action="buy"]');
            if (!btn) continue;
            let tag = btn.querySelector(`.${TAG}`);
            const amount = btn.querySelector('.btn-cost-amount');
            if (!amount) {
                if (tag) tag.remove();
                continue;
            }
            let text = '';
            try {
                const preview = btn.hasAttribute('data-original-html') && typeof game.calculateMaxUpgradePreview === 'function'
                    ? game.calculateMaxUpgradePreview(id) : null;
                const cost = preview ? num(preview.totalCost) : parseAmount(amount.textContent);
                const extra = gain(id, current.R, current.f, preview ? preview.targetLevel : undefined);
                if (!(extra > 0)) text = 'no gain now';
                else if (Number.isFinite(cost) && cost > 0) text = `~${duration(cost / extra)} payback${preview ? ' (max)' : ''}`;
            } catch (e) { text = ''; }
            if (!tag) {
                tag = document.createElement('span');
                tag.className = TAG;
                btn.appendChild(tag);
            }
            if (tag.textContent !== text) tag.textContent = text;
        }
    } finally {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
}

// The game rebuilds the shop's HTML now and then; put the text straight back.
const observer = new MutationObserver(() => {
    if (document.querySelector('.upgrade-node[data-id="p_value"], .upgrade-node[data-id="p_capacity"]')) apply();
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

mod.onUnload(() => {
    observer.disconnect();
    for (const t of document.querySelectorAll(`.${TAG}`)) t.remove();
});
// Titles an earlier version of this mod left on buttons.
for (const b of document.querySelectorAll('[data-birbmod-payback-title]')) {
    b.removeAttribute('title');
    delete b.dataset.birbmodPaybackTitle;
}

sample();
compute();
apply();
const timer = setInterval(() => { sample(); compute(); apply(); }, 1000);
mod.onUnload(() => clearInterval(timer));
mod.log(`payback running (suffixes: ${Object.keys(suffixes).slice(0, 6).join(' ')}...)`);
