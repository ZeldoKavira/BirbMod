// A "Mods" page in the game's own settings menu, listing every option mods registered with mod.setting(...).
// The button goes under the main panel's UI-size button; the page is drawn in the game's own modal style and sits on
// top of the main panel (Back shows the main panel again, Close closes the menu as the game's X does).
// F10 opens the settings straight on this page.

const BUTTON_ID = 'birbmod-settings-btn';
const PAGE_ID = 'birbmod-settings-page';

const btnCss = 'width:100%; padding:12px; font-size:14px;';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const onOff = v => (v ? 'ON' : 'OFF');

function modal() {
    return document.getElementById('settings-modal');
}

// ---- the Mods button on the main panel ----

function injectButton() {
    const m = modal();
    const main = m && m.querySelector('.settings-main-panel');
    if (!main || main.querySelector(`#${BUTTON_ID}`)) return;
    const anchor = main.querySelector('#settings-ui-scale-btn');
    const b = document.createElement('button');
    b.id = BUTTON_ID;
    b.type = 'button';
    b.className = 'birb-btn primary';
    b.style.cssText = 'width:100%; padding:12px; font-size:16px;';
    b.textContent = 'Mods';
    b.onclick = () => openPage();
    if (anchor) anchor.insertAdjacentElement('afterend', b);
    else (main.querySelector('div') || main).appendChild(b);
}

// ---- the page ----

function openPage() {
    const m = modal();
    if (!m) return;
    const main = m.querySelector('.settings-main-panel');
    if (main) main.style.display = 'none';
    let page = document.getElementById(PAGE_ID);
    if (!page) {
        page = document.createElement('div');
        page.id = PAGE_ID;
        page.className = 'birb-modal-container';
        page.style.minWidth = '350px';
        m.appendChild(page);
    }
    render();
}

function closePage(andMenu) {
    const page = document.getElementById(PAGE_ID);
    if (page) page.remove();
    const m = modal();
    if (!m) return;
    const main = m.querySelector('.settings-main-panel');
    if (main) main.style.display = '';
    if (andMenu) {
        const x = document.getElementById('settings-close-main-btn');
        if (x) x.click();
        else m.remove();
    }
}

function render() {
    const page = document.getElementById(PAGE_ID);
    if (!page) return;
    const groups = new Map();
    for (const s of window.BirbMod.settings) {
        const key = s.section || s.mod;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
    }
    const rows = [];
    for (const [section, list] of groups) {
        rows.push(`<div style="color:#94a3b8;font-size:12px;margin-top:6px;text-transform:uppercase;letter-spacing:.05em">${esc(section)}</div>`);
        list.forEach((s, i) => {
            const id = `${s.mod}:${s.id}`;
            let value;
            try { value = s.get(); } catch (e) { value = undefined; }
            if (s.type === 'choice') {
                rows.push(`<div style="font-size:14px;margin-top:2px">${esc(s.label)}</div>
                    <div style="display:flex;flex-wrap:wrap;gap:6px">${s.choices.map(c => `
                        <button type="button" class="birb-btn ${c.value === value ? 'primary' : 'secondary'}" data-set="${esc(id)}" data-value="${esc(JSON.stringify(c.value))}"
                            style="flex:1 1 0; min-width:0; padding:8px 2px; font-size:13px;${c.value === value ? '' : 'opacity:.75;'}">${esc(c.label)}</button>`).join('')}
                    </div>`);
            } else {
                rows.push(`<button type="button" class="birb-btn primary" data-toggle="${esc(id)}" style="${btnCss}">${esc(s.label)}: ${onOff(value)}</button>`);
            }
            if (s.note) {
                let note;
                try { note = typeof s.note === 'function' ? s.note() : s.note; } catch (e) { note = ''; }
                if (note) rows.push(`<div style="color:#94a3b8;font-size:12px;margin:-4px 2px 0">${esc(note)}</div>`);
            }
        });
    }
    page.innerHTML = `
        <div class="birb-modal-header"><h2>Mods</h2></div>
        <div class="birb-modal-card" style="padding: 20px; max-height: 60vh; overflow-y: auto;">
            <div style="display:flex; flex-direction:column; gap:10px;">
                ${rows.join('') || '<div style="color:#94a3b8">No mod settings.</div>'}
            </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:20px;">
            <button type="button" data-nav="back" class="birb-btn secondary" style="padding:12px;">Back</button>
            <button type="button" data-nav="close" class="birb-btn secondary" style="padding:12px;">Close</button>
        </div>`;
    const find = id => window.BirbMod.settings.find(s => `${s.mod}:${s.id}` === id);
    page.onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.nav) return closePage(b.dataset.nav === 'close');
        const s = find(b.dataset.toggle || b.dataset.set);
        if (!s) return;
        try {
            if (b.dataset.toggle) s.set(!s.get());
            else s.set(JSON.parse(b.dataset.value));
        } catch (err) {
            mod.log(`setting ${s.mod}:${s.id} failed: ${err}`);
        }
        render();
    };
}

const unlisten = window.BirbMod.onSettingsChanged(render);
mod.onUnload(unlisten);

// The game rebuilds the modal's contents when it opens and between its own sub-pages; put the button back each time.
const observer = new MutationObserver(() => { if (modal()) injectButton(); });
observer.observe(document.body, { childList: true, subtree: true });
mod.onUnload(() => {
    observer.disconnect();
    const b = document.getElementById(BUTTON_ID);
    if (b) b.remove();
    closePage(false);
});
injectButton();

// F10: open the settings on the Mods page (or close the page if it's showing).
const onKey = e => {
    if (e.key !== 'F10') return;
    e.preventDefault();
    e.stopPropagation();
    if (document.getElementById(PAGE_ID)) return closePage(true);
    if (!modal() && typeof game.toggleSettings === 'function') game.toggleSettings();
    injectButton();
    openPage();
};
window.addEventListener('keydown', onKey, true);
mod.onUnload(() => window.removeEventListener('keydown', onKey, true));

mod.log('Mods settings page ready (F10)');
