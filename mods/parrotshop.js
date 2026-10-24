// A PARROT tab in the shop sidebar (next to POPCORN / REBIRB / SEEDS / NEST) for spending the parrot's skill points
// without opening the parrot menu, with buttons that open the equipment forge and the chest-opening window:
// Vitality, Recovery and Strength, each with a buy button for the chosen amount
// (1 point or a share of what's available) and a MAX button that spends everything on it. The tab's badge shows the
// points waiting to be spent. On/off from Settings > Mods.
//
// Spending does what the parrot menu's Upgrade tab does: add the points to the skill, take them off the parrot's
// skill points, then have the expedition manager recompute the parrot's bonuses and save.

const KEY = 'birbmod_parrotshop';
let settings = { on: true, amount: '1' };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not saved */ }
}

const SKILLS = [
    { id: 'hp', name: 'VITALITY', desc: '+1 HP per point' },
    { id: 'lifeRegen', name: 'RECOVERY', desc: '+1 HP/s per point' },
    { id: 'damage', name: 'STRENGTH', desc: '+1 Damage per point' },
];
const AMOUNTS = [
    { id: '1', label: '1' },
    { id: '0.1', label: '10%' },
    { id: '0.25', label: '25%' },
    { id: '0.5', label: '50%' },
    { id: '0.75', label: '75%' },
];

const parrot = () => game.state.parrot;
const available = () => {
    const p = parrot();
    return p && typeof p.skillPoints === 'number' ? Math.max(0, Math.floor(p.skillPoints)) : 0;
};
// Points one buy press spends at the chosen amount.
function chosenAmount() {
    const have = available();
    if (have <= 0) return 0;
    if (settings.amount === '1') return 1;
    return Math.max(1, Math.floor(have * Number(settings.amount)));
}

function spend(skill, points) {
    const p = parrot();
    if (!p || typeof p.skillPoints !== 'number') {
        mod.log('parrot skill points are not a plain number; not spending');
        return;
    }
    const n = Math.min(available(), Math.floor(points));
    if (n <= 0) return;
    p.skills[skill] = (p.skills[skill] || 0) + n;
    p.skillPoints = Math.max(0, p.skillPoints - n);
    game.expeditionManager.refreshParrotBonuses(game.getEquippedArtifactNames(), game.getEquipmentMultipliers(), game.getEquippedArtifactInfusionLevels());
    game.requestSave();
    game.refreshParrotMenu?.();
    game.updateParrotSkillPointBadge?.();
    mod.log(`parrot: ${n} point(s) into ${skill}`);
    refresh();
}

// ---- tab and page ----

const tabBar = document.querySelector('#tab-bar .tab-btn')?.parentElement;
const content = game.tabContent;

const tab = document.createElement('button');
tab.className = 'tab-btn';
tab.id = 'birbmod-tab-parrot';
tab.dataset.tab = 'BIRBMOD_PARROT';
tab.innerHTML = 'PARROT <div class="tab-badge" style="display:none"></div>';
const badge = tab.querySelector('.tab-badge');

const page = document.createElement('div');
page.id = 'birbmod-parrot-tab';
page.style.display = 'none';
page.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0 8px;padding:8px 10px;background:#0b0f19;border:1px solid #566c86;border-radius:4px">
        <span style="font-size:14px;color:#566c86;font-family:var(--font-pixel-mono)">POINTS AVAILABLE</span>
        <span data-v="avail" style="font-size:20px;color:#f1c40f;font-family:var(--font-pixel-mono)">0</span>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:8px">
        <button class="birb-btn secondary" data-open="forge" style="flex:1 1 0;padding:6px 0;font-size:14px;font-family:var(--font-pixel-mono)">FORGE</button>
        <button class="birb-btn secondary" data-open="chests" style="flex:1 1 0;padding:6px 0;font-size:14px;font-family:var(--font-pixel-mono)">CHESTS <span data-v="chests"></span></button>
    </div>
    <div data-v="amounts" style="display:flex;gap:4px;margin-bottom:8px"></div>
    ${SKILLS.map(s => `
    <div class="upgrade-node" data-skill="${s.id}">
        <div class="upgrade-content">
            <div class="upgrade-header">
                <div class="upgrade-name">
                    <span class="upgrade-name-title" style="white-space:nowrap;line-height:1.1">${s.name}</span>
                    <span class="upgrade-name-description" style="white-space:nowrap;line-height:1.1">${s.desc}</span>
                </div>
            </div>
            <div class="upgrade-values">
                <span class="curr-value" data-v="${s.id}-now">0</span> <span class="arrow">&gt;</span> <span class="next-value" data-v="${s.id}-next">0</span>
            </div>
            <div class="upgrade-buttons">
                <button class="upgrade-btn-action" data-buy="${s.id}"><span class="btn-cost"><span class="btn-cost-amount" data-v="${s.id}-cost">0 SP</span></span></button>
                <button class="upgrade-btn-max" data-max="${s.id}">MAX</button>
            </div>
        </div>
    </div>`).join('')}`;
const el = {};
for (const node of page.querySelectorAll('[data-v]')) el[node.dataset.v] = node;
for (const a of AMOUNTS) {
    const b = document.createElement('button');
    b.className = 'birb-btn secondary';
    b.dataset.amount = a.id;
    b.textContent = a.label;
    Object.assign(b.style, { flex: '1 1 0', padding: '4px 0', fontSize: '14px', fontFamily: 'var(--font-pixel-mono)' });
    b.addEventListener('click', () => { settings.amount = a.id; save(); refresh(); });
    el.amounts.appendChild(b);
}

// The equipment forge or the chest-opening window, the way the parrot menu's Equipment tab buttons open them.
function openWindow(button) {
    if (button.dataset.open === 'forge') {
        if (game.isParrotForgeUnlocked?.() === true && game.state.parrot) game.parrotForgeUI.open();
        else {
            const r = button.getBoundingClientRect();
            game.showDOMFloatText('The forge is not unlocked yet', r.left, r.top - 20);
        }
        return;
    }
    if (game.tryStartExpeditionChestTutorial?.() === true) return;
    const c = game.getChestOpeningCounts(true);
    const total = ['material', 'equipment'].reduce((n, kind) =>
        n + ['common', 'uncommon', 'rare', 'epic', 'legendary'].reduce((m, r) => m + (c[kind]?.[r] || 0), 0), 0);
    if (total > 0) game.chestOpeningUI.open(c);
    else {
        const r = button.getBoundingClientRect();
        game.showDOMFloatText('No chests to open', r.left, r.top - 20);
    }
}

// While the MAX button is hovered, the row previews spending everything (as the game's own MAX does).
let hoverMax = null;
page.addEventListener('click', e => {
    const buy = e.target.closest('[data-buy]'), max = e.target.closest('[data-max]'), win = e.target.closest('[data-open]');
    if (win) openWindow(win);
    else if (buy) spend(buy.dataset.buy, chosenAmount());
    else if (max) spend(max.dataset.max, available());
});
page.addEventListener('mouseover', e => {
    const max = e.target.closest('[data-max]');
    const next = max ? max.dataset.max : null;
    if (next !== hoverMax) { hoverMax = next; refresh(); }
});
page.addEventListener('mouseleave', () => { hoverMax = null; refresh(); });

const fmt = v => game.formatNum(v);
function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
}

function refresh() {
    const p = parrot();
    if (!p) return;
    const have = available();
    setText(badge, have > 0 ? fmt(have) : '');
    badge.style.display = have > 0 ? 'flex' : 'none';
    if (page.style.display === 'none') return;
    setText(el.avail, fmt(have));
    const chests = game.getTotalOpenableChestCount?.(true) || 0;
    setText(el.chests, chests > 0 ? `(${fmt(chests)})` : '');
    for (const b of el.amounts.children) b.className = `birb-btn ${b.dataset.amount === settings.amount ? 'primary' : 'secondary'}`;
    const step = chosenAmount();
    for (const s of SKILLS) {
        const now = p.skills?.[s.id] || 0, add = hoverMax === s.id ? have : step;
        setText(el[`${s.id}-now`], fmt(now));
        setText(el[`${s.id}-next`], fmt(now + add));
        setText(el[`${s.id}-cost`], `${fmt(add)} SP${hoverMax === s.id ? ' (max)' : ''}`);
        const buy = page.querySelector(`[data-buy="${s.id}"]`), max = page.querySelector(`[data-max="${s.id}"]`);
        buy.classList.toggle('affordable', step > 0);
        buy.disabled = step <= 0;
        max.classList.toggle('affordable', have > 0);
        max.disabled = have <= 0;
    }
}

// The game's own tabs swap what #tab-content shows; this tab hides it and shows its page in the same place.
let open = false;
function show(v) {
    open = v;
    page.style.display = v ? '' : 'none';
    content.style.display = v ? 'none' : '';
    tab.classList.toggle('active', v);
    if (v) {
        for (const b of tabBar.querySelectorAll('.tab-btn')) if (b !== tab) b.classList.remove('active');
        refresh();
    }
}

// Clicking a game tab closes this one. The game ignores a click on the tab it already shows, so mark that one active.
const onTabClick = e => {
    const b = e.target.closest('.tab-btn');
    if (!b) return;
    if (b === tab) { show(true); return; }
    if (!open) return;
    show(false);
    if (b.dataset.tab === game.currentTab) b.classList.add('active');
};

function install() {
    tabBar.appendChild(tab);
    content.insertAdjacentElement('afterend', page);
    tabBar.addEventListener('click', onTabClick, true);
}
function uninstall() {
    if (open) {
        show(false);
        tabBar.querySelector(`.tab-btn[data-tab="${game.currentTab}"]`)?.classList.add('active');
    }
    tab.remove();
    page.remove();
    tabBar.removeEventListener('click', onTabClick, true);
}

const visibleNow = () => settings.on && !!parrot() && (parrot().level || 0) > 0;
let installed = false;
const tick = setInterval(() => {
    if (!tabBar || !content) return;
    const want = visibleNow();
    if (want !== installed) { want ? install() : uninstall(); installed = want; }
    if (!installed) return;
    // Something of the game's re-marked one of its tabs (a tutorial, a tab hiding itself): give way to it.
    if (open && [...tabBar.querySelectorAll('.tab-btn.active')].some(b => b !== tab)) show(false);
    refresh();
}, 250);
mod.onUnload(() => {
    clearInterval(tick);
    if (installed) uninstall();
});
if (!tabBar || !content) mod.log('parrot tab unavailable: shop tab bar not found');

mod.setting({
    id: 'on', section: 'Parrot', label: 'PARROT tab in the shop sidebar', type: 'toggle',
    get: () => settings.on,
    set: v => { settings.on = !!v; save(); },
    note: 'Spend skill points on Vitality, Recovery and Strength from the sidebar. Hover MAX to preview spending all.',
});

mod.log(`parrot shop tab ${settings.on ? 'on' : 'off'}`);
