// Real-time income meter and dropped-time logger.
//
// The game's own "/s" is gross gains per *simulated* second over a 3-minute window, so it hides spending and any
// real time the game skipped. This shows, per real second over the last 60 s: net (balance change) and gross
// (everything collected), next to the game's figure converted to per real second; plus how much of the time that
// should have been simulated (real time x game speed) was, and how much was dropped. The game drops real time
// whenever one tick waits longer than 0.1 s (5 s while the page is hidden).
//
// Log (birbmod.log): a line for every tick that drops more than 0.2 s, and a summary every minute.
// Shown/hidden from Settings > Mods (or F9); drag it by its title. It keeps measuring while hidden.

const WINDOW_SECONDS = 60;
const DROP_LOG_SECONDS = 0.2;

const CURRENCIES = [
    ['popcorn', 'Popcorn', g => g.state.resources.popcorn],
    ['goldenpopcorn', 'Golden popcorn', g => g.state.resources.goldenPopcorn],
    ['echopopcorn', 'Echo popcorn', g => g.state.resources.echoPopcorn],
    ['feathers', 'Feathers', g => g.state.resources.goldenFeathers],
    ['seeds', 'Seeds', g => g.state.resources.sunflowerSeeds],
    ['moneta', 'Moneta', g => g.state.resources.monetariaMoneta],
    ['bruteore', 'Brute ore', g => g.state.resources.bruteOre],
    ['goldore', 'Gold ore', g => (g.getGoldOreMaterialCount ? g.getGoldOreMaterialCount() : 0)],
    ['twigs', 'Twigs', g => g.nestManager.getState().resources.twigs],
    ['wood', 'Wood', g => g.nestManager.getState().resources.wood],
];

// Resource values are plain numbers or big-number objects; numbers are fine for a rate readout.
function toNum(v) {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toNumber === 'function') return v.toNumber();
    const n = Number(v);
    return Number.isFinite(n) ? n : parseFloat(String(v)) || 0;
}

function fmt(n) {
    if (!Number.isFinite(n)) return '?';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a < 100) return sign + a.toFixed(a < 10 ? 2 : 1);
    // Whole numbers from here up, in the game's own style (thousands separators, then K/M/B... suffixes).
    let s;
    try { s = typeof game.formatNum === 'function' ? game.formatNum(Math.round(a)) : null; } catch (e) { s = null; }
    if (s == null) s = a >= 1e6 ? a.toExponential(2) : Math.round(a).toLocaleString();
    return sign + s;
}

// ---- dropped time: wrap the game's logic tick ----

// expected: simulated seconds the ticks should have produced - each tick's real gap x the game speed then.
const ticks = { real: 0, expected: 0, dropped: 0, drops: 0, maxGap: 0, ticks: 0 };
const minute = { dropped: 0, drops: 0, maxGap: 0, ticks: 0, start: performance.now() / 1000, startSim: game.time, startExpected: 0 };
const speedNow = () => Math.max(0.25, Math.min(10, Number(game.debugGameSpeedMultiplier) || 1)); // the game's own clamp
const originalLogic = game.logicLoop;
const tickWrapper = function () {
    const now = performance.now();
    const gap = Math.max(0, (now - game.lastTime) / 1000);
    const hidden = typeof document !== 'undefined' && document.hidden;
    const cap = hidden || game.backgroundLogicDeferred === true ? 5 : 0.1;
    ticks.ticks++; minute.ticks++;
    ticks.real += gap;
    ticks.expected += gap * speedNow();
    if (gap > ticks.maxGap) ticks.maxGap = gap;
    if (gap > minute.maxGap) minute.maxGap = gap;
    if (gap > cap) {
        const lost = gap - cap;
        ticks.dropped += lost; ticks.drops++;
        minute.dropped += lost; minute.drops++;
        if (lost >= DROP_LOG_SECONDS)
            mod.log(`dropped ${lost.toFixed(2)} s (tick gap ${(gap * 1000).toFixed(0)} ms, ${hidden ? 'hidden' : 'visible'}, map ${game.currentMap})`);
    }
    return originalLogic.apply(this, arguments);
};
game.logicLoop = tickWrapper;
mod.onUnload(() => {
    if (game.logicLoop === tickWrapper) game.logicLoop = originalLogic;
});

// ---- gross gains: count what's added to the game's own per-currency accumulators ----

const gross = {};
let proxied = null, proxy = null;
function attachGross() {
    const acc = game.currencyAccumulators;
    if (!acc || acc === proxy) return;
    proxied = acc;
    proxy = new Proxy(acc, {
        set(target, key, value) {
            const before = toNum(target[key]);
            const after = toNum(value);
            if (after > before) gross[key] = (gross[key] || 0) + (after - before);
            target[key] = value;
            return true;
        },
    });
    game.currencyAccumulators = proxy;
}
attachGross();
mod.onUnload(() => {
    if (game.currencyAccumulators === proxy && proxied) game.currencyAccumulators = proxied;
});

// ---- sampling ----

const samples = [];
function sample() {
    attachGross(); // the game swaps in a fresh accumulator object now and then
    const s = { t: performance.now() / 1000, sim: game.time, expected: ticks.expected, bal: {}, gross: {} };
    for (const [key, , get] of CURRENCIES) {
        try { s.bal[key] = toNum(get(game)); } catch (e) { s.bal[key] = 0; }
        s.gross[key] = gross[key] || 0;
    }
    samples.push(s);
    while (samples.length > WINDOW_SECONDS + 1) samples.shift();
}

function rates() {
    if (samples.length < 2) return null;
    const a = samples[0], b = samples[samples.length - 1];
    const real = b.t - a.t;
    if (real <= 0) return null;
    const out = { real, sim: b.sim - a.sim, expected: b.expected - a.expected, rows: [] };
    // The game's figure is per simulated second; this many simulated seconds passed per real one.
    const simPerReal = out.sim > 0 ? out.sim / real : speedNow();
    for (const [key, label] of CURRENCIES) {
        // Gross: counted gains, or (for currencies the game measures by balance) the positive balance steps.
        let g = b.gross[key] - a.gross[key];
        if (g <= 0) {
            g = 0;
            for (let i = 1; i < samples.length; i++) g += Math.max(0, samples[i].bal[key] - samples[i - 1].bal[key]);
        }
        const net = b.bal[key] - a.bal[key];
        const shown = toNum(game.currencyRates && game.currencyRates[key]) * simPerReal;
        const badge = document.getElementById(`badge-${key}`);
        const visible = badge ? badge.style.display !== 'none' : false;
        if (!visible && g === 0 && net === 0 && shown === 0) continue;
        out.rows.push({ key, label, net: net / real, gross: g / real, shown });
    }
    return out;
}

// ---- panel ----

const POS_KEY = 'birbmod_meter_pos';
const panel = document.createElement('div');
panel.id = 'birbmod-meter';
Object.assign(panel.style, {
    position: 'fixed', zIndex: 99999, minWidth: '280px', padding: '6px 8px 8px',
    background: 'rgba(14, 17, 27, 0.92)', border: '2px solid #333c57', borderRadius: '4px',
    color: '#e5e7eb', font: '12px Galmuri11, monospace', lineHeight: '1.45', userSelect: 'none',
    boxShadow: '0 4px 14px rgba(0,0,0,.5)',
});
let pos = { left: 200, top: 46 }; // clear of the game's currency badges on the left
try { pos = JSON.parse(localStorage.getItem(POS_KEY)) || pos; } catch (e) { /* default */ }
panel.style.left = `${pos.left}px`;
panel.style.top = `${pos.top}px`;
panel.innerHTML = `
    <div data-role="title" style="cursor:move;display:flex;justify-content:space-between;gap:12px;color:#94a3b8;margin-bottom:4px">
        <span>Real-time meter <span style="color:#64748b">(last ${WINDOW_SECONDS}s)</span></span><span style="color:#64748b">F9</span>
    </div>
    <div data-role="body"></div>`;
const body = panel.querySelector('[data-role=body]');
document.body.appendChild(panel);
mod.onUnload(() => panel.remove());

// Keep clicks on the panel away from the game.
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

const VISIBLE_KEY = 'birbmod_meter_visible';
let visible = true;
try { visible = JSON.parse(localStorage.getItem(VISIBLE_KEY)) !== false; } catch (e) { visible = true; }
function setVisible(v) {
    visible = !!v;
    panel.style.display = visible ? '' : 'none';
    try { localStorage.setItem(VISIBLE_KEY, JSON.stringify(visible)); } catch (e) { /* not saved */ }
}
setVisible(visible);
mod.setting({
    id: 'visible', section: 'Meter', label: 'Real-time income meter', type: 'toggle',
    get: () => visible, set: setVisible, note: 'Net and gross income per real second, and dropped time. F9 also shows/hides it.',
});

const onKey = e => {
    if (e.key !== 'F9') return;
    e.preventDefault();
    e.stopPropagation();
    setVisible(!visible);
    window.BirbMod.settingsChanged();
};
window.addEventListener('keydown', onKey, true);
mod.onUnload(() => window.removeEventListener('keydown', onKey, true));

function cell(text, color, align = 'right') {
    return `<td style="padding:0 0 0 10px;text-align:${align};${color ? `color:${color};` : ''}white-space:nowrap">${text}</td>`;
}

function render() {
    const r = rates();
    if (!r) {
        body.textContent = 'Measuring...';
        return;
    }
    const simPct = r.expected > 0 ? (100 * r.sim) / r.expected : 100;
    const speed = speedNow();
    const rows = r.rows.map(row => `<tr>
        <td style="white-space:nowrap">${row.label}</td>
        ${cell(`${row.net >= 0 ? '+' : ''}${fmt(row.net)}`, row.net > 0 ? '#22c55e' : row.net < 0 ? '#ef4444' : '#8b8b8b')}
        ${cell(fmt(row.gross), '#cbd5e1')}
        ${cell(fmt(row.shown), '#64748b')}
    </tr>`).join('');
    const timeColor = simPct < 98 ? '#f59e0b' : '#22c55e';
    body.innerHTML = `
        <table style="border-collapse:collapse;width:100%">
            <tr style="color:#64748b">${cell('per real s', null, 'left').replace('padding:0 0 0 10px;', '')}${cell('net')}${cell('gross')}${cell('game')}</tr>
            ${rows || `<tr><td colspan="4" style="color:#64748b">No income yet</td></tr>`}
        </table>
        <div style="margin-top:4px;color:${timeColor}">Simulated ${simPct.toFixed(1)}% of ${speed === 1 ? 'real time' : `real time x ${speed}`}</div>
        <div style="color:${ticks.dropped > 0 ? '#f59e0b' : '#64748b'}">Dropped ${ticks.dropped.toFixed(1)} s in ${ticks.drops} ticks; longest gap ${(ticks.maxGap * 1000).toFixed(0)} ms</div>`;
}

// One-minute summary in the log.
function logMinute() {
    const now = performance.now() / 1000;
    const real = now - minute.start;
    const sim = game.time - minute.startSim;
    const expected = ticks.expected - minute.startExpected;
    const r = rates();
    const income = r ? r.rows.filter(x => x.gross > 0 || x.net !== 0).map(x => `${x.key} net ${fmt(x.net)}/s gross ${fmt(x.gross)}/s game ${fmt(x.shown)}/s`).join(' | ') : '';
    mod.log(`minute: real ${real.toFixed(1)} s at ${speedNow()}x, simulated ${sim.toFixed(1)} s of ${expected.toFixed(1)} s expected (${((100 * sim) / Math.max(expected, 0.001)).toFixed(1)}%), ` +
        `dropped ${minute.dropped.toFixed(2)} s in ${minute.drops} ticks, longest gap ${(minute.maxGap * 1000).toFixed(0)} ms, ${minute.ticks} ticks` +
        (income ? ` | ${income}` : ''));
    Object.assign(minute, { dropped: 0, drops: 0, maxGap: 0, ticks: 0, start: now, startSim: game.time, startExpected: ticks.expected });
}

sample();
const sampler = setInterval(() => { sample(); render(); }, 1000);
const minuteTimer = setInterval(logMinute, 60000);
mod.onUnload(() => { clearInterval(sampler); clearInterval(minuteTimer); });
render();
mod.log('meter running');
