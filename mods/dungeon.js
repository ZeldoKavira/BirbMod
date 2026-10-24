// Dungeon (expedition run) helpers, both set from Settings > Mods:
//   Stats panel - while on a run map, a small panel with the same figures as the parrot menu's Overview tab
//     (level and XP, max health, damage, HP regen and build points, each with its base/bonus split), refreshed
//     4x a second. Drag it by its title; the position is remembered.
//   Monster attack - an attack label (the game's sword icon and number) over every monster's health bar, the same
//     figure the game shows while Shift is held, without holding Shift.

const KEY = 'birbmod_dungeon';
let settings = { stats: true, attack: false };
try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) { /* defaults */ }
function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not saved */ }
}

// ---- stats panel ----

// The Overview's base values: 100 + 1 per point for health and damage, 1 per point for regen (game constants).
const BASE_HP = 100, BASE_DAMAGE = 100, PER_POINT = 1;

const POS_KEY = 'birbmod_dungeon_pos';
const panel = document.createElement('div');
panel.id = 'birbmod-dungeon-stats';
Object.assign(panel.style, {
    position: 'fixed', zIndex: 950, width: '330px', padding: '0 10px 10px', boxSizing: 'border-box',
    background: '#10141f', border: '2px solid #566c86', borderRadius: '4px', boxShadow: 'var(--pixel-window-shadow)',
    color: '#fff', userSelect: 'none', display: 'none',
});
let pos = { left: 12, top: 172 }; // under the currency badges
try { pos = JSON.parse(localStorage.getItem(POS_KEY)) || pos; } catch (e) { /* default */ }
panel.style.left = `${pos.left}px`;
panel.style.top = `${pos.top}px`;

const card = (id, label, color) => `
    <div class="parrot-overview-stat-card" style="padding:6px;gap:2px">
        <div style="font-size:13px;color:${color};font-family:var(--font-pixel)">${label}</div>
        <div data-v="${id}" style="font-size:20px;color:#fff;font-family:var(--font-retro)">0</div>
        <div class="parrot-overview-stat-breakdown" style="width:100%;margin-top:4px;padding:4px">
            <div data-v="${id}-a" style="font-size:13px;color:#7d93b2;font-family:var(--font-pixel-mono)"></div>
            <div data-v="${id}-b" style="font-size:13px;font-family:var(--font-pixel-mono)"></div>
        </div>
    </div>`;
panel.innerHTML = `
    <div data-role="title" style="cursor:move;padding:6px 0 4px;font-family:var(--font-pixel-mono);font-size:18px;color:#fff;text-shadow:2px 2px 0 #000;text-transform:uppercase">Parrot</div>
    <div class="parrot-overview-progress-card" style="margin:8px 0 8px;padding:10px 8px 8px">
        <div data-v="level" class="parrot-overview-level-badge companion-level-badge companion-level-badge--parrot">LV 0</div>
        <div class="parrot-overview-progress-head">
            <span style="font-size:14px;color:#566c86;font-family:var(--font-pixel-mono)">PROGRESS</span>
            <span data-v="xp" style="font-size:14px;color:#fff;font-family:var(--font-pixel-mono)">XP: 0 / 0</span>
        </div>
        <div class="parrot-overview-xp-track" style="height:10px"><div data-v="xpbar" class="parrot-overview-xp-fill"></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${card('hp', 'MAX HEALTH', '#a3e635')}
        ${card('dmg', 'DAMAGE', '#ff9aa2')}
        ${card('regen', 'HP REGEN', '#7dd3fc')}
        ${card('sp', 'BUILD POINTS', '#f1c40f')}
    </div>`;
document.body.appendChild(panel);
mod.onUnload(() => panel.remove());

const el = {};
for (const node of panel.querySelectorAll('[data-v]')) el[node.dataset.v] = node;

// Keep clicks on the panel away from the game.
for (const type of ['mousedown', 'mouseup', 'click', 'wheel', 'pointerdown', 'pointerup'])
    panel.addEventListener(type, e => e.stopPropagation());

panel.querySelector('[data-role=title]').addEventListener('mousedown', e => {
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

const fmt = v => game.formatNum(v);
const signed = (v, unit = '') => `${v >= 0 ? '+' : '-'}${fmt(Math.abs(v))}${unit}`;
function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
}

// Same figures as the Overview tab (the game's own getParrotTotalStats and skill points).
function refreshStats() {
    const p = game.state.parrot, progress = game.state.expedition?.progress;
    const xp = progress?.xp ?? p.xp ?? 0, next = progress?.xpToNextLevel ?? 0;
    const total = game.getParrotTotalStats();
    const skills = p.skills || {};
    setText(el.level, `LV ${fmt(p.level)}`);
    setText(el.xp, `XP: ${fmt(Math.floor(xp))} / ${fmt(next)}`);
    el.xpbar.style.width = `${next > 0 ? Math.min(100, xp / next * 100) : 0}%`;

    const baseHp = BASE_HP + (skills.hp || 0) * PER_POINT;
    const baseDmg = BASE_DAMAGE + (skills.damage || 0) * PER_POINT;
    const baseRegen = (skills.lifeRegen || 0) * PER_POINT;
    setText(el.hp, fmt(total.hp));
    setText(el['hp-a'], `BASE: ${fmt(baseHp)}`);
    setText(el['hp-b'], `BONUS: ${signed(total.hp - baseHp)}`);
    el['hp-b'].style.color = '#9be564';
    setText(el.dmg, fmt(total.damage));
    setText(el['dmg-a'], `BASE: ${fmt(baseDmg)}`);
    setText(el['dmg-b'], `BONUS: ${signed(total.damage - baseDmg)}`);
    el['dmg-b'].style.color = '#ffb4bc';
    setText(el.regen, `${fmt(total.lifeRegen)}/s`);
    setText(el['regen-a'], `BASE: ${fmt(baseRegen)}/s`);
    setText(el['regen-b'], `BONUS: ${signed(total.lifeRegen - baseRegen, '/s')}`);
    el['regen-b'].style.color = '#9be7ff';

    const available = Math.max(0, Math.floor(Number(p.skillPoints) || 0));
    const invested = Math.max(0, (skills.hp || 0) + (skills.lifeRegen || 0) + (skills.damage || 0));
    setText(el.sp, fmt(available + invested));
    el.sp.style.color = available + invested > 0 ? '#f1c40f' : '#fff';
    setText(el['sp-a'], `AVAILABLE: ${fmt(available)}`);
    el['sp-a'].style.color = '#f1c40f';
    setText(el['sp-b'], `INVESTED: ${fmt(invested)}`);
    el['sp-b'].style.color = '#7d93b2';
}

let statsErrorLogged = false;
const tick = setInterval(() => {
    const show = settings.stats && typeof game.isRunMap === 'function' && game.isRunMap() && !!game.state.parrot;
    panel.style.display = show ? '' : 'none';
    if (!show) return;
    try { refreshStats(); } catch (e) {
        if (!statsErrorLogged) mod.log(`dungeon stats error: ${(e && e.stack) || e}`);
        statsErrorLogged = true;
    }
}, 250);
mod.onUnload(() => clearInterval(tick));

// ---- monster attack labels ----
// The render system draws each monster's health bar through renderExpeditionEnemyHealthOverlay, which hands the
// bar renderer its options. The game only adds the attack line while inspecting (Shift), so after each normal bar
// this draws the same line (sword icon + attack in red) just above it, using the bar's measured bounds.

const rs = game.renderSystem;
const bars = rs && rs.rankedHealthBarRenderer;
const proto = rs && Object.getPrototypeOf(rs);
let lastBarOptions = null, capturing = false, attackErrorLogged = false;

function drawAttack(ctx, rc, enemy, opts) {
    const box = bars.measure(ctx, rc, enemy, opts);
    if (!box) return;
    const zoom = Math.max(0.001, rc.zoom);
    const text = rc.formatNum(Math.ceil(Math.max(0, Number(enemy.attack) || 0))).replace(/^(-?\d+(?:\.\d+)?)([A-Za-z]+)$/, '$1 $2');
    ctx.save();
    // The bar renderer works in screen pixels: map the screen point back onto the context it was given.
    const x = (box.left + box.right) / 2, y = box.top - 4;
    if (opts.screenSpace) ctx.translate(x, y);
    else {
        const px = (opts.x - Math.floor(rc.cameraX)) * zoom, py = (opts.y - Math.floor(rc.cameraY)) * zoom;
        ctx.translate(opts.x + (x - px) / zoom, opts.y + (y - py) / zoom);
        ctx.scale(1 / zoom, 1 / zoom);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.font = '14px "Tiny5", monospace';
    const w = ctx.measureText(text).width, left = Math.round(-(16 + w) / 2);
    const icon = bars.attackIcon;
    if (icon && icon.complete && icon.naturalWidth > 0) {
        ctx.save();
        ctx.translate(left, -13);
        ctx.beginPath();
        ctx.moveTo(3, 0); ctx.lineTo(12, 0); ctx.lineTo(12, 13); ctx.lineTo(0, 13); ctx.lineTo(0, 3); ctx.lineTo(3, 3);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(icon, -4, -3);
        ctx.restore();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#121421';
    ctx.strokeText(text, left + 16, -2);
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText(text, left + 16, -2);
    ctx.restore();
}

if (rs && bars && typeof proto.renderExpeditionEnemyHealthOverlay === 'function') {
    const barRender = Object.getPrototypeOf(bars).render;
    bars.render = function (ctx, rc, enemy, opts) {
        if (capturing) lastBarOptions = opts;
        return barRender.apply(this, arguments);
    };
    rs.renderExpeditionEnemyHealthOverlay = function (ctx, rc, enemy, visual) {
        if (!settings.attack) return proto.renderExpeditionEnemyHealthOverlay.apply(this, arguments);
        capturing = true;
        lastBarOptions = null;
        let result;
        try { result = proto.renderExpeditionEnemyHealthOverlay.apply(this, arguments); } finally { capturing = false; }
        // No bar drawn (dead, hidden, or shown by the game's own Shift inspect, which has the attack already).
        if (!lastBarOptions || lastBarOptions.damageText || (this.isDoppelgangerDisguised && this.isDoppelgangerDisguised(enemy))) return result;
        try { drawAttack(ctx, rc, enemy, lastBarOptions); } catch (e) {
            if (!attackErrorLogged) mod.log(`attack label error: ${(e && e.stack) || e}`);
            attackErrorLogged = true;
        }
        return result;
    };
    mod.onUnload(() => {
        delete rs.renderExpeditionEnemyHealthOverlay;
        delete bars.render;
    });
} else mod.log('monster attack labels unavailable: render system not found');

// ---- on the Mods settings page ----

mod.setting({
    id: 'stats', section: 'Dungeon', label: 'Parrot stats panel on runs', type: 'toggle',
    get: () => settings.stats,
    set: v => { settings.stats = !!v; save(); },
    note: 'The Overview tab\'s figures while on a run map. Drag it by its title.',
});
mod.setting({
    id: 'attack', section: 'Dungeon', label: 'Always show monster attack', type: 'toggle',
    get: () => settings.attack,
    set: v => { settings.attack = !!v; save(); },
    note: 'The attack the game shows while Shift is held, over every monster\'s health bar.',
});

mod.log(`dungeon helpers running (stats panel ${settings.stats ? 'on' : 'off'}, attack labels ${settings.attack ? 'on' : 'off'})`);
