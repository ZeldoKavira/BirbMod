// Birb mod core: installed once per page load by BirbLauncher. Keeps the game handle the launcher found, runs mods
// with cleanup hooks so they can be unloaded and reloaded in place, and buffers log lines for the launcher to collect.
(() => {
    const CORE_VERSION = 1;
    const prev = window.BirbMod;
    if (prev && prev.coreVersion === CORE_VERSION && prev.game) {
        delete window.__birbGameHandoff;
        return 'kept';
    }
    if (prev) {
        try { prev.unloadAll(); } catch (e) { /* replacing it anyway */ }
    }

    const game = window.__birbGameHandoff;
    delete window.__birbGameHandoff;
    if (!game) throw new Error('BirbMod core: no game handle');

    const logs = [];
    const mods = {};

    const api = {
        coreVersion: CORE_VERSION,
        game,
        mods,

        log(line) {
            logs.push(`${new Date().toISOString()} ${line}`);
            if (logs.length > 5000) logs.splice(0, logs.length - 5000);
        },

        drainLog() {
            return logs.splice(0);
        },

        // factory(mod, game): mod.onUnload(fn) registers cleanup, mod.log(line) logs under the mod's name.
        run(name, factory) {
            api.unload(name);
            const cleanups = [];
            const mod = {
                name,
                game,
                log: line => api.log(`[${name}] ${line}`),
                onUnload: fn => cleanups.push(fn),
            };
            mods[name] = { cleanups, loadedAt: Date.now() };
            try {
                factory(mod, game);
            } catch (e) {
                api.log(`[${name}] load failed: ${(e && e.stack) || e}`);
                api.unload(name);
                throw e;
            }
            api.log(`[${name}] loaded`);
            return 'ok';
        },

        unload(name) {
            const m = mods[name];
            if (!m) return false;
            delete mods[name];
            for (const fn of m.cleanups.reverse()) {
                try { fn(); } catch (e) { api.log(`[${name}] unload error: ${(e && e.stack) || e}`); }
            }
            api.log(`[${name}] unloaded`);
            return true;
        },

        unloadAll() {
            Object.keys(mods).forEach(n => api.unload(n));
        },

        list() {
            return Object.keys(mods);
        },
    };

    window.BirbMod = api;
    return 'installed';
})()
