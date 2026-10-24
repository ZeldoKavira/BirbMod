// Game speed control, through the game's own debugGameSpeedMultiplier: each logic tick simulates real time x this.
// The game clamps it to 0.25x-10x. Things it times by the wall clock (offline earnings, cultivation timers) don't
// speed up, and expedition runs lose their fixed-step mode when it isn't exactly 1x.
// F10 shows/hides the control; drag it by its title. The setting is remembered; unloading the mod puts 1x back.

const KEY = 'birbmod_speed';
const POS_KEY = 'birbmod_speed_pos';
const PRESETS = [0.5, 1, 2, 3, 5, 10];
const MIN = 0.25, MAX = 10;

const clamp = v => Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100));
let speed = 1;
try { speed = clamp(Number(JSON.parse(localStorage.getItem(KEY))) || 1); } catch (e) { speed = 1; }
function set(v) {
    speed = clamp(v);
    game.debugGameSpeedMultiplier = speed;
    try { localStorage.setItem(KEY, JSON.stringify(speed)); } catch (e) { /* not saved */ }
    render();
    mod.log(`speed ${speed}x`);
}

// ---- panel ----

const panel = document.createElement('div');
panel.id = 'birbmod-speed';
Object.assign(panel.style, {
    position: 'fixed', zIndex: 99999, padding: '6px 8px 7px',
    background: 'rgba(14, 17, 27, 0.92)', border: '2px solid #333c57', borderRadius: '4px',
    color: '#e5e7eb', font: '12px Galmuri11, monospace', userSelect: 'none', boxShadow: '0 4px 14px rgba(0,0,0,.5)',
});
let pos = { left: 200, top: 250 };
try { pos = JSON.parse(localStorage.getItem(POS_KEY)) || pos; } catch (e) { /* default */ }
panel.style.left = `${pos.left}px`;
panel.style.top = `${pos.top}px`;

const btnStyle = 'background:#1f2537;border:1px solid #333c57;color:#e5e7eb;font:inherit;padding:1px 6px;border-radius:3px;cursor:pointer';
panel.innerHTML = `
    <div data-role="title" style="cursor:move;display:flex;justify-content:space-between;gap:12px;color:#94a3b8;margin-bottom:4px">
        <span>Game speed</span><span style="color:#64748b">F10</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px">
        <button data-step="-1" style="${btnStyle}">-</button>
        <span data-role="value" style="min-width:42px;text-align:center;font-size:14px"></span>
        <button data-step="1" style="${btnStyle}">+</button>
    </div>
    <div style="display:flex;gap:4px;margin-top:5px">
        ${PRESETS.map(p => `<button data-preset="${p}" style="${btnStyle}">${p}x</button>`).join('')}
    </div>`;
document.body.appendChild(panel);
mod.onUnload(() => panel.remove());

const valueEl = panel.querySelector('[data-role=value]');
function render() {
    valueEl.textContent = `${speed}x`;
    valueEl.style.color = speed === 1 ? '#e5e7eb' : '#facc15';
    for (const b of panel.querySelectorAll('[data-preset]'))
        b.style.borderColor = Number(b.dataset.preset) === speed ? '#facc15' : '#333c57';
}

// -/+ step through the presets (or by 0.25 below 1x).
function step(dir) {
    const steps = [0.25, 0.5, 0.75, ...PRESETS.filter(p => p >= 1)];
    const i = steps.findIndex(s => s >= speed - 1e-9);
    const at = i < 0 ? steps.length - 1 : steps[i] === speed ? i : dir > 0 ? i - 1 : i;
    set(steps[Math.min(steps.length - 1, Math.max(0, at + dir))]);
}

panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) set(Number(b.dataset.preset));
    else if (b.dataset.step) step(Number(b.dataset.step));
});
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

const onKey = e => {
    if (e.key !== 'F10') return;
    e.preventDefault();
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
};
window.addEventListener('keydown', onKey, true);
mod.onUnload(() => window.removeEventListener('keydown', onKey, true));

// Keep the setting applied even if something else writes the multiplier.
const keep = setInterval(() => {
    if (Number(game.debugGameSpeedMultiplier) !== speed) game.debugGameSpeedMultiplier = speed;
}, 1000);
mod.onUnload(() => {
    clearInterval(keep);
    game.debugGameSpeedMultiplier = 1;
});

game.debugGameSpeedMultiplier = speed;
render();
mod.log(`speed control running at ${speed}x`);
