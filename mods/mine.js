// Minecart timers, each on/off from Settings > Mods:
// - No minecart cooldown (on by default): after a giant ore is beaten, the cart shows a countdown and won't take you
//   to the next one until it ends. The game keeps it as a saved wall-clock time (state.mine.bossRespawnAt, set on each
//   win and read only by the cart); this mod clears it, so the cart is ready again as soon as you're back.
// - No time limit on giant ores (off by default): the cart normally gives 60 seconds to break a giant ore before the
//   cave collapses. The game's mine journey sets that as a wall-clock deadline when the cart arrives; its update()
//   starts the collapse once the clock passes it, and damage only counts before it. This keeps that deadline at
//   infinity while you're in the giant ore's room, and hides the countdown the ore's health bar draws under it.

const KEY = 'birbmod_mine';
let settings = { noCooldown: true, noOreLimit: false };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not saved */ }
}

const LIMIT_MS = 60 * 1000;
const journey = game.mineJourney;
const rs = game.renderSystem;
const kits = [rs?.mineOreHealthBarRenderer?.healthBarKit, rs?.mineJourneyRenderer?.healthBarKit].filter(Boolean);

// In the giant ore's room, arrived and still fighting (no ride under way, no result yet).
const fighting = j => j.bossRoom && !j.trip && j.outcome === null;

// Turning it off mid-fight gives a fresh 60 seconds rather than an instant collapse.
function giveBackTimer() {
    if (journey && journey.deadline === Infinity) journey.deadline = Date.now() + LIMIT_MS;
}

if (journey && typeof journey.update === 'function') {
    const update = Object.getPrototypeOf(journey).update;
    journey.update = function () {
        if (settings.noOreLimit && fighting(this)) this.deadline = Infinity;
        const result = update.apply(this, arguments);
        // The deadline is set at the end of the update the cart arrives in.
        if (settings.noOreLimit && fighting(this)) this.deadline = Infinity;
        return result;
    };
} else {
    mod.log('mine journey not found; giant ore timer left alone');
}

// The health bar draws "GIANT ORE ... 60s" under the bar while mineJourney.bossRoom is set and not travelling.
// With no limit there's nothing to count down, so hand it a render state that skips that row.
for (const kit of kits) {
    const render = Object.getPrototypeOf(kit).render;
    kit.render = function (ctx, rc) {
        const mj = rc?.mineJourney;
        if (mj && mj.bossRoom && mj.remainingSeconds === Infinity) {
            const view = Object.create(rc);
            view.mineJourney = Object.assign({}, mj, { travelling: true });
            arguments[1] = view;
        }
        return render.apply(this, arguments);
    };
}

// The cooldown is only ever set when a giant ore is beaten (the cart is out of the room by the time it would show).
const clearCooldown = setInterval(() => {
    const m = game.state?.mine;
    if (settings.noCooldown && m && Number(m.bossRespawnAt) > 0) {
        m.bossRespawnAt = 0;
        game.requestSave?.();
    }
}, 250);

mod.onUnload(() => {
    clearInterval(clearCooldown);
    if (journey) delete journey.update;
    for (const kit of kits) delete kit.render;
    giveBackTimer();
});

mod.setting({
    id: 'noCooldown', section: 'Mine', label: 'No minecart cooldown', type: 'toggle',
    get: () => settings.noCooldown,
    set: v => { settings.noCooldown = !!v; save(); },
    note: 'The cart is ready for the next giant ore right after you beat one, without the countdown.',
});
mod.setting({
    id: 'noOreLimit', section: 'Mine', label: 'No time limit on giant ores', type: 'toggle',
    get: () => settings.noOreLimit,
    set: v => { settings.noOreLimit = !!v; save(); if (!settings.noOreLimit) giveBackTimer(); },
    note: 'The minecart challenge\'s 60 s limit is removed; ride the cart back when you want to leave.',
});

mod.log(`minecart cooldown ${settings.noCooldown ? 'removed' : 'kept'}, giant ore time limit ${settings.noOreLimit ? 'removed' : 'kept'}`);
