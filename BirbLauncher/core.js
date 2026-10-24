// Birb mod core: installed once per page load by BirbLauncher. Keeps the game handle the launcher found, runs mods
// with cleanup hooks so they can be unloaded and reloaded in place, keeps the settings mods offer (shown by
// settings.js on a Mods page in the game's settings menu), and buffers log lines for the launcher to collect.
(() => {
    const CORE_VERSION = 2;
    const prev = window.BirbMod;
    if (prev && prev.coreVersion === CORE_VERSION && prev.game) {
        delete window.__birbGameHandoff;
        return 'kept';
    }
    if (prev) {
        try { prev.unloadAll(); } catch (e) { /* replacing it anyway */ }
    }

    const game = window.__birbGameHandoff || (prev && prev.game);
    delete window.__birbGameHandoff;
    if (!game) throw new Error('BirbMod core: no game handle');

    const logs = [];
    const mods = {};
    const settings = [];          // { mod, id, label, type: 'toggle' | 'choice', get(), set(v), choices?, note? }
    const settingsListeners = new Set();
    const settingsChanged = () => settingsListeners.forEach(fn => { try { fn(); } catch (e) { /* a listener's problem */ } });

    const api = {
        coreVersion: CORE_VERSION,
        game,
        mods,
        settings,

        log(line) {
            logs.push(`${new Date().toISOString()} ${line}`);
            if (logs.length > 5000) logs.splice(0, logs.length - 5000);
        },

        drainLog() {
            return logs.splice(0);
        },

        // Something a setting's value depends on changed (e.g. a hotkey flipped it): redraw the Mods page.
        settingsChanged,

        onSettingsChanged(fn) {
            settingsListeners.add(fn);
            return () => settingsListeners.delete(fn);
        },

        // factory(mod, game):
        //   mod.onUnload(fn)    cleanup when the mod is unloaded or reloaded
        //   mod.log(line)       a line in birbmod.log under the mod's name
        //   mod.setting(def)    an option on the Mods settings page; removed with the mod
        run(name, factory) {
            api.unload(name);
            const cleanups = [];
            const mod = {
                name,
                game,
                log: line => api.log(`[${name}] ${line}`),
                onUnload: fn => cleanups.push(fn),
                setting: def => {
                    const entry = Object.assign({ mod: name }, def);
                    settings.push(entry);
                    cleanups.push(() => {
                        const i = settings.indexOf(entry);
                        if (i >= 0) settings.splice(i, 1);
                        settingsChanged();
                    });
                    settingsChanged();
                    return entry;
                },
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
