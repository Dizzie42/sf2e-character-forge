/** Text size control shared by the Forge and Level Up windows (per user, saved as a client setting). */
const MODULE_ID = "sf2e-character-forge";
export const SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

export function registerTextSize() {
    game.settings.register(MODULE_ID, "textScale", {
        name: "SF2EFORGE.Settings.TextScale.Name",
        hint: "SF2EFORGE.Settings.TextScale.Hint",
        scope: "client", config: true, type: Number, default: 1,
        choices: Object.fromEntries(SCALES.map((s) => [s, `${Math.round(s * 100)}%`])),
        onChange: () => refreshOpenWindows(),
    });
}

export function textScale() {
    try { const v = Number(game.settings.get(MODULE_ID, "textScale")); return SCALES.includes(v) ? v : 1; } catch (e) { return 1; }
}

export function fsStyle() { return `--fs:${textScale()}`; }

export function fsBar() {
    const s = textScale();
    return `<div class="fsbar" role="group" aria-label="Text size"><b>Text size</b>
        <button type="button" data-fs="-1" title="Smaller text" aria-label="Smaller text" ${s <= SCALES[0] ? "disabled" : ""}>A−</button>
        <span class="pct">${Math.round(s * 100)}%</span>
        <button type="button" data-fs="1" title="Bigger text" aria-label="Bigger text" ${s >= SCALES.at(-1) ? "disabled" : ""}>A+</button>
        ${s !== 1 ? '<button type="button" data-fs="0" title="Reset to 100%" aria-label="Reset text size">↺</button>' : ""}</div>`;
}

/** Handle a click on the A−/A+ buttons. Returns true if it was one. */
export function handleTextSizeClick(ev) {
    const t = ev.target.closest("[data-fs]");
    if (!t) return false;
    const dir = Number(t.dataset.fs);
    const cur = SCALES.indexOf(textScale());
    const next = dir === 0 ? 1 : SCALES[Math.max(0, Math.min(SCALES.length - 1, cur + dir))];
    game.settings.set(MODULE_ID, "textScale", next);
    return true;
}

const BASE = { "sf2e-levelup": [1100, 780], default: [1200, 820] };
function refreshOpenWindows() {
    const s = textScale();
    const apps = [...(foundry.applications?.instances?.values?.() ?? [])].filter((a) => a.element?.classList?.contains("sf2e-forge"));
    for (const app of apps) {
        const [w, h] = app.element.classList.contains("sf2e-levelup") ? BASE["sf2e-levelup"] : BASE.default;
        try {
            if (s > 1 && app.setPosition) app.setPosition({ width: Math.min(window.innerWidth - 40, Math.round(w * Math.min(s, 1.5))), height: Math.min(window.innerHeight - 40, Math.round(h * Math.min(s, 1.3))) });
        } catch (e) { /* ignore */ }
        const root = app.element.querySelector(".forge-root");
        if (root) root.style.setProperty("--fs", s);
        app.render();
    }
}
