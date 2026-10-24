// Game speed control, through the game's own debugGameSpeedMultiplier: each logic tick simulates real time x this.
// The game clamps it to 0.25x-10x. Things it times by the wall clock (offline earnings, cultivation timers) don't
// speed up, and expedition runs lose their fixed-step mode when it isn't exactly 1x. Boss and elite respawns are
// wall-clock too; this mod moves their deadlines so they count down at the chosen speed as well (see below).
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
    note: 'Boss and elite respawns follow it too. Other wall-clock timers (offline earnings, cultivation) do not.',
});

// Keep the setting applied even if something else writes the multiplier.
const keep = setInterval(() => {
    if (Number(game.debugGameSpeedMultiplier) !== speed) game.debugGameSpeedMultiplier = speed;
}, 1000);

// ---- boss and elite respawns ----
// Their respawns are saved wall-clock deadlines (expedition state's enemyRespawnCooldowns, mirrored on the live
// enemy as respawnAt), so they ignore the multiplier. While the game runs at another speed, pull every deadline in
// (or push it out, below 1x) by the difference between game time and real time.
let lastShift = performance.now();
const shiftRespawns = setInterval(() => {
    const now = performance.now(), dt = Math.min(1000, now - lastShift);
    lastShift = now;
    if (speed === 1) return;
    const em = game.expeditionManager, deadlines = em && em.state && em.state.enemyRespawnCooldowns;
    if (!deadlines || typeof deadlines !== 'object') return;
    const shift = Math.round((speed - 1) * dt);
    let changed = false;
    for (const key of Object.keys(deadlines)) {
        const at = Number(deadlines[key]);
        if (at > 0) { deadlines[key] = at - shift; changed = true; }
    }
    const run = em.getActiveRun && em.getActiveRun();
    for (const e of (run && run.enemies) || []) {
        if (e.respawnKey && Number(e.respawnAt) > 0) e.respawnAt = Number(e.respawnAt) - shift;
    }
    if (changed && em.bossRespawnCooldowns && typeof em.bossRespawnCooldowns.invalidate === 'function') em.bossRespawnCooldowns.invalidate(deadlines);
}, 250);

mod.onUnload(() => {
    clearInterval(shiftRespawns);
    clearInterval(keep);
    game.debugGameSpeedMultiplier = 1;
});

game.debugGameSpeedMultiplier = speed;
mod.log(`speed control running at ${speed}x`);
