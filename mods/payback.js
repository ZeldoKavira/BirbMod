// Payback time on the popcorn upgrades' buy buttons: how long the extra popcorn an upgrade brings takes to repay its
// cost, at your current income.
//
// Income R is popcorn collected per real second over the last 60 s (the game's own figure until there's enough data).
// What an upgrade adds depends on what limits income. f is the share of the last minute the meadow sat full:
//   Popcorn Value    R x (next / current - 1)                  - value multiplies every pickup
//   Faster Popcorns  R x (1 - f) x (interval now / next - 1)   - only helps while spawning is the limit
//   Wing Training    R x f x (speed next / now - 1)            - only helps while collecting is the limit
//   Popcorn Cap      R x f x (sqrt(cap next / now) - 1)        - a denser field means shorter flights between pickups
// These are estimates (marked ~); hover the button for the numbers behind one.

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
    const shown = num(game.currencyRates && game.currencyRates.popcorn);
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
function gain(id, R, f) {
    const level = protoLevel.call(um, id);
    const now = effectAt(id, level), next = effectAt(id, level + 1);
    if (!(now > 0) || !(next > 0) || now === next) return { extra: 0, how: 'no change next level' };
    switch (UPGRADES[id]) {
        case 'value': {
            // The card's own figures (multipliers included), so the tooltip matches what the card shows.
            const shown = l => parseAmount(String(game.getShopUpgradeEffectHtml(id, l)).replace(/<[^>]*>/g, ''));
            const a = shown(level), b = shown(level + 1);
            const [v0, v1] = a > 0 && b > 0 ? [a, b] : [now, next];
            return { extra: R * (v1 / v0 - 1), how: `value ${fmt(v0)} -> ${fmt(v1)}` };
        }
        case 'speed':
            return { extra: R * (1 - f) * (now / next - 1), how: `spawn ${now}s -> ${next}s, meadow full ${Math.round(100 * f)}% of the time` };
        case 'move':
            return { extra: R * f * (next / now - 1), how: `speed x${now.toFixed(2)} -> x${next.toFixed(2)}, meadow full ${Math.round(100 * f)}% of the time` };
        case 'capacity':
            return { extra: R * f * (Math.sqrt(next / now) - 1), how: `cap ${now} -> ${next}, meadow full ${Math.round(100 * f)}% of the time` };
    }
    return { extra: 0, how: '' };
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

let cache = { at: 0, values: {} };

function compute() {
    const { rate: R, source } = income();
    const f = fullShare();
    const values = {};
    for (const id of Object.keys(UPGRADES)) {
        try { values[id] = { ...gain(id, R, f), R, source }; } catch (e) { values[id] = null; }
    }
    cache = { at: performance.now(), values };
}

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
            const v = cache.values[id];
            if (!amount || !v) {
                if (tag) tag.remove();
                continue;
            }
            const cost = parseAmount(amount.textContent);
            let text, title;
            if (!(v.extra > 0) || !Number.isFinite(cost)) {
                text = v.extra > 0 ? '' : 'no gain now';
                title = `Payback: ${v.how}. At the moment this upgrade wouldn't add popcorn.`;
            } else {
                const secs = cost / v.extra;
                text = `~${duration(secs)} payback`;
                title = `Pays back in about ${duration(secs)}: +${fmt(v.extra)} popcorn/s for ${fmt(cost)}.\n` +
                    `${v.how}. Income ${fmt(v.R)}/s (${v.source}).`;
            }
            if (!tag) {
                tag = document.createElement('span');
                tag.className = TAG;
                btn.appendChild(tag);
            }
            if (tag.textContent !== text) tag.textContent = text;
            // The game resets the title on updates, so compare with what's on the button now.
            btn.dataset.birbmodPaybackTitle = '1';
            if (btn.title !== title) btn.title = title;
        }
    } finally {
        observer.observe(document.body, { childList: true, subtree: true });
    }
}

// The game rebuilds the shop's HTML now and then; put the text straight back.
const observer = new MutationObserver(() => {
    if (document.querySelector('.upgrade-node[data-id="p_value"], .upgrade-node[data-id="p_capacity"]')) apply();
});
observer.observe(document.body, { childList: true, subtree: true });

mod.onUnload(() => {
    observer.disconnect();
    for (const t of document.querySelectorAll(`.${TAG}`)) t.remove();
    for (const b of document.querySelectorAll('[data-birbmod-payback-title]')) {
        b.removeAttribute('title');
        delete b.dataset.birbmodPaybackTitle;
    }
});

sample();
compute();
apply();
const timer = setInterval(() => { sample(); compute(); apply(); }, 1000);
mod.onUnload(() => clearInterval(timer));
mod.log(`payback running (suffixes: ${Object.keys(suffixes).slice(0, 6).join(' ')}...)`);
