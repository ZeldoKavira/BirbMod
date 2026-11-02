// No time limit on the giant ore. Taking the minecart down to a mine area's giant ore normally gives 60 seconds to
// break it before the cave collapses and sends you back. With this on, the giant ore never collapses: the cart ride
// back is still there for when you want to leave. On/off from Settings > Mods.
//
// The game's mine journey sets a wall-clock deadline (Date.now() + 60 s) when the cart arrives at the giant ore; its
// update() starts the collapse once the clock passes it, and damage only counts before it. This mod keeps that deadline
// at infinity while you're in the giant ore's room, and hides the countdown the ore's health bar draws under it.

const KEY = 'birbmod_mine';
let settings = { noTimer: true };
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
        if (settings.noTimer && fighting(this)) this.deadline = Infinity;
        const result = update.apply(this, arguments);
        // The deadline is set at the end of the update the cart arrives in.
        if (settings.noTimer && fighting(this)) this.deadline = Infinity;
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

mod.onUnload(() => {
    if (journey) delete journey.update;
    for (const kit of kits) delete kit.render;
    giveBackTimer();
});

mod.setting({
    id: 'noTimer', section: 'Mine', label: 'No time limit on giant ores', type: 'toggle',
    get: () => settings.noTimer,
    set: v => { settings.noTimer = !!v; save(); if (!settings.noTimer) giveBackTimer(); },
    note: 'The minecart challenge\'s 60 s limit is removed; ride the cart back when you want to leave.',
});

mod.log(`giant ore time limit ${settings.noTimer ? 'removed' : 'kept'}`);
