// Game speed control, through the game's own debugGameSpeedMultiplier: each logic tick simulates real time x this.
// The game clamps it to 0.25x-10x. Things it times by the wall clock (offline earnings, cultivation timers) don't
// speed up, and expedition runs lose their fixed-step mode when it isn't exactly 1x.
// Set from Settings > Mods. The setting is remembered; unloading the mod puts 1x back.

const KEY = 'birbmod_speed';
const MIN = 0.25, MAX = 10;

const clamp = v => Math.min(MAX, Math.max(MIN, Math.round(v * 100) / 100));
let speed = 1;
try { speed = clamp(Number(JSON.parse(localStorage.getItem(KEY))) || 1); } catch (e) { speed = 1; }
function set(v) {
    speed = clamp(v);
    game.debugGameSpeedMultiplier = speed;
    try { localStorage.setItem(KEY, JSON.stringify(speed)); } catch (e) { /* not saved */ }
    mod.log(`speed ${speed}x`);
}

// ---- on the Mods settings page ----

mod.setting({
    id: 'speed', section: 'Game speed', label: 'Speed', type: 'choice',
    choices: [0.25, 0.5, 1, 2, 3, 5, 10].map(v => ({ value: v, label: `${v}x` })),
    get: () => speed, set,
    note: 'Wall-clock timers (offline earnings, cultivation) do not speed up.',
});

// Keep the setting applied even if something else writes the multiplier.
const keep = setInterval(() => {
    if (Number(game.debugGameSpeedMultiplier) !== speed) game.debugGameSpeedMultiplier = speed;
}, 1000);
mod.onUnload(() => {
    clearInterval(keep);
    game.debugGameSpeedMultiplier = 1;
});

game.debugGameSpeedMultiplier = speed;
mod.log(`speed control running at ${speed}x`);
