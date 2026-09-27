import { fsBar, fsStyle, handleTextSizeClick } from "./textsize.mjs";
import { CharacterForgeApp, sharedData, descHTML } from "./app.mjs";
import { ATTRS, ATTR_LABEL } from "./data.mjs";
import { applyLevel, blankPlan, ctxFromActor, deriveLevel, undoInfo, undoLevel, MODULE_ID, RANK_LETTER } from "./levels.mjs";
import { handleLevelEvent, renderSection, sectionsFor, gainChips } from "./levelui.mjs";

const { ApplicationV2 } = foundry.applications.api;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sgn = (n) => (n >= 0 ? "+" : "") + n;

export class LevelUpApp extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        classes: ["sf2e-forge", "sf2e-levelup"],
        tag: "div",
        window: { title: "Level Up", icon: "fa-solid fa-circle-up", resizable: true },
        position: { width: 1100, height: 780 },
    };

    constructor(actor, options = {}) {
        super({ id: `sf2e-levelup-${actor.id}`, ...options });
        this.actor = actor;
        this.data = sharedData();
        this.q = {};
        this.step = "overview";
        this.busy = false;
        this.confirmUndo = 0;
        this.plan = this.#loadDraft();
        this.progress = { msg: "Reading compendiums…", pct: 0 };
        this.prefs = { hideRare: false, sources: null };
        try { Object.assign(this.prefs, JSON.parse(localStorage.getItem(`${MODULE_ID}.prefs`) || "{}")); } catch (e) { /* ignore */ }
    }

    get title() { return `Level Up: ${this.actor.name}`; }
    get #draftKey() { return `${MODULE_ID}.levelup.${this.actor.id}.${(this.actor.level ?? this.actor.system.details.level.value) + 1}`; }
    #loadDraft() { try { const r = localStorage.getItem(this.#draftKey); if (r) return foundry.utils.mergeObject(blankPlan(), JSON.parse(r)); } catch (e) { /* ignore */ } return blankPlan(); }
    #saveDraft() { try { localStorage.setItem(this.#draftKey, JSON.stringify(this.plan)); } catch (e) { /* ignore */ } }
    visible(x, selected) {
        if (selected) return true;
        const r = x.system?.traits?.rarity ?? "common";
        if (this.prefs.hideRare && r !== "common") return false;
        const src = this.prefs.sources;
        return !(src && src.length && !src.includes(x.system?.publication?.title || "Other"));
    }

    async _prepareContext() {
        if (!this.data.ready) return { loading: true };
        const level = this.actor.level ?? this.actor.system.details.level.value;
        if (level >= 20) return { loading: false, max: true };
        const ctx = await ctxFromActor(this.data, this.actor);
        const LV = await deriveLevel(this.data, ctx, this.plan, (x, sel) => this.visible(x, sel));
        this.LV = LV;
        return { loading: false, LV };
    }

    async _renderHTML(context) {
        if (context.loading) return `<div class="forge-root" style="${fsStyle()}"><div class="forge-loading"><div class="bar"><span style="width:${Math.round(this.progress.pct * 100)}%"></span></div><p>${esc(this.progress.msg)}</p></div></div>`;
        if (context.max) return `<div class="forge-root" style="${fsStyle()}"><div class="forge-loading"><p>${esc(this.actor.name)} is already level 20.</p>${this.undoBlock()}</div></div>`;
        const LV = context.LV;
        const steps = [...sectionsFor(LV), ["review", "Level up"]];
        if (!steps.some((s) => s[0] === this.step)) this.step = "overview";
        const idx = steps.findIndex((s) => s[0] === this.step);
        const status = (id) => (id === "overview" || id === "review" ? "ok" : LV.issues.some((i) => i[0] === id) ? "warn" : "ok");
        const rail = steps.map(([id, label], i) => `<button type="button" class="step ${this.step === id ? "on" : ""}" data-step="${id}"><span class="no">${String(i + 1).padStart(2, "0")}</span><span>${label}</span><span class="dot ${status(id)}"></span></button>`).join("");
        const nav = `<div class="navbtns">${idx > 0 ? `<button type="button" class="btn" data-go="${steps[idx - 1][0]}"><i class="fa-solid fa-arrow-left"></i> ${steps[idx - 1][1]}</button>` : "<span></span>"}${idx < steps.length - 1 ? `<button type="button" class="btn primary" data-go="${steps[idx + 1][0]}">${steps[idx + 1][1]} <i class="fa-solid fa-arrow-right"></i></button>` : ""}</div>`;
        const main = this.step === "review" ? this.vReview(LV) : renderSection(this, LV, this.step) + (this.step === "overview" ? this.undoBlock() : "");
        return `<div class="forge-root" style="${fsStyle()}">
            <nav class="rail">${fsBar()}<div class="startlvl"><b>${esc(this.actor.name)}</b><span class="note">Level ${LV.ctx.level - 1} → ${LV.ctx.level}</span></div>${rail}</nav>
            <section class="main" data-scroll="main">${main}${nav}</section>
            <aside class="sheet" data-scroll="sheet">${this.sheet(LV)}</aside></div>`;
    }

    sheet(LV) {
        const c = LV.ctx, p = LV.plan;
        const mods = { ...c.mods };
        for (const a of p.boosts ?? []) if (mods[a] < 4) mods[a]++;
        const ranks = { ...c.ranks };
        if (p.skillInc && p.skillInc in ranks) ranks[p.skillInc]++;
        for (const s of p.intSkills ?? []) ranks[s] = Math.max(1, ranks[s]);
        const trained = this.data.skills.filter((s) => ranks[s.slug] > 0);
        const chosenFeats = LV.slots.filter((s) => s.value).map((s) => this.data.entry(s.value)?.name).filter(Boolean);
        return `<div class="sh-head"><div class="nm">${esc(c.name)}</div><div class="ln">${esc([c.heritage?.name ?? c.ancestry?.name, c.cls?.name].filter(Boolean).join(" · "))}</div></div>
            <div class="vitals"><div><b>${c.level}</b><span>New level</span></div><div><b>+${LV.hpGain}</b><span>Max HP</span></div><div><b>${chosenFeats.length}/${LV.slots.length}</b><span>Feats</span></div></div>
            <div class="attrs">${ATTRS.map((a) => `<div class="${(p.boosts ?? []).includes(a) ? "key" : ""}" title="${ATTR_LABEL[a]}"><b>${sgn(mods[a])}</b><span>${a}</span></div>`).join("")}</div>
            <div class="sh-sec"><h4>Skills after this level</h4><div class="rows">${trained.map((s) => `<span>${esc(s.label)}</span><span class="n">${RANK_LETTER[ranks[s.slug]]}</span>`).join("")}</div></div>
            ${chosenFeats.length ? `<div class="sh-sec"><h4>New feats</h4><div class="rows">${chosenFeats.map((n) => `<span>${esc(n)}</span><span></span>`).join("")}</div></div>` : ""}
            <div class="sh-sec"><h4>To finish</h4>${LV.issues.length ? `<div class="issues">${LV.issues.map((i) => `<div class="issue">${esc(i[1])}</div>`).join("")}</div>` : '<div class="allgood">Ready to level up.</div>'}</div>`;
    }

    undoBlock() {
        const u = undoInfo(this.actor);
        if (!u) return "";
        const armed = Date.now() - this.confirmUndo < 4000;
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Undo</span><h2>Undo the last level up</h2></div>
            <p class="lede">Puts ${esc(this.actor.name)} back exactly as they were at level ${u.from}, before the last level up (${new Date(u.at).toLocaleString()}). Anything changed on the sheet since then is lost too.</p>
            <button type="button" class="btn ${armed ? "primary" : ""}" data-undo="1"><i class="fa-solid fa-rotate-left"></i> ${armed ? "Click again to undo" : `Undo back to level ${u.from}`}</button></div>`;
    }

    vReview(LV) {
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${LV.ctx.level}</span><h2>Ready to level up</h2></div>
            <div class="meta">${gainChips(LV)}</div>
            ${LV.issues.length ? `<div class="warnbox">${LV.issues.length} choice${LV.issues.length > 1 ? "s" : ""} still open (listed on the right). You can level up anyway and finish on the sheet.</div>` : '<div class="okbox">Everything is chosen.</div>'}
            <p class="note">A snapshot of ${esc(this.actor.name)} is saved first, so you can undo this level up from this window afterwards.</p>
            <div class="inline"><button type="button" class="btn primary big" data-levelup="1" ${this.busy ? "disabled" : ""}><i class="fa-solid fa-circle-up"></i> ${this.busy ? "Leveling up…" : `Level up to ${LV.ctx.level}`}</button></div></div>`;
    }

    async _onFirstRender(context, options) {
        await super._onFirstRender?.(context, options);
        this.element.addEventListener("click", (ev) => this.#onEvent(ev));
        this.element.addEventListener("change", (ev) => this.#onEvent(ev));
        this.element.addEventListener("input", (ev) => {
            const d = ev.target.dataset;
            if (d.q) { this.q[d.q] = ev.target.value; clearTimeout(this._qt); this._qt = setTimeout(() => this.render(), 150); }
        });
        if (!this.data.ready) {
            this.data.load((msg, pct) => { this.progress = { msg, pct }; const el = this.element?.querySelector(".forge-loading p"); if (el) el.textContent = msg; })
                .then(() => this.render())
                .catch((err) => { console.error(err); ui.notifications.error("Character Forge couldn't read your compendiums. Press F12 and check the console for details."); });
        }
    }

    async #onEvent(ev) {
        if (ev.type === "click" && handleTextSizeClick(ev)) return;
        if (ev.type === "click" && ev.target.closest("[data-qtoggle]")) {
            this.prefs.hideUnmet = this.prefs.hideUnmet === false;
            try { const all = JSON.parse(localStorage.getItem(`${MODULE_ID}.prefs`) || "{}"); all.hideUnmet = this.prefs.hideUnmet; localStorage.setItem(`${MODULE_ID}.prefs`, JSON.stringify(all)); } catch (e) { /* ignore */ }
            return this.render();
        }
        if (handleLevelEvent(ev, () => this.plan, () => { this.#saveDraft(); this.render(); })) return;
        if (ev.type !== "click") return;
        const t = ev.target.closest("button, a[data-open]");
        if (!t) return;
        const d = t.dataset;
        if (d.open) { ev.preventDefault(); (await fromUuid(d.open))?.sheet?.render(true); return; }
        if (d.step || d.go) { this.step = d.step || d.go; this._resetScroll = true; return this.render(); }
        if (d.undo) {
            if (Date.now() - this.confirmUndo > 4000) { this.confirmUndo = Date.now(); return this.render(); }
            this.confirmUndo = 0;
            try { const lvl = await undoLevel(this.actor); ui.notifications.info(`${this.actor.name} is back to level ${lvl}.`); this.plan = this.#loadDraft(); this.step = "overview"; return this.render(); }
            catch (err) { console.error(err); ui.notifications.error(`Undo failed: ${err.message}`); return; }
        }
        if (d.levelup) {
            if (this.busy) return;
            this.busy = true; this.render();
            try {
                const key = this.#draftKey;
                await applyLevel(this.data, this.actor, this.plan, { snapshot: true });
                try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
                ui.notifications.info(`${this.actor.name} is now level ${this.actor.level ?? this.actor.system.details.level.value}.`);
                this.busy = false;
                await this.close();
                this.actor.sheet?.render(true);
            } catch (err) {
                console.error("Character Forge | level up failed", err);
                ui.notifications.error(`Level up didn't finish: ${err.message}. If anything changed, open Level Up again and use Undo.`);
                this.busy = false; this.render();
            }
        }
    }
}

// Borrow the creator's shared UI helpers
for (const m of ["picker", "docDetail", "featDetail", "choiceNodes", "_replaceHTML"]) {
    LevelUpApp.prototype[m] = CharacterForgeApp.prototype[m];
}
LevelUpApp.prototype.descHTML = (h, m) => descHTML(h, m);

const open = new Map();
export function openLevelUp(actor) {
    if (!actor || actor.type !== "character") return ui.notifications.warn("Level Up only works on player characters.");
    if (!actor.isOwner) return ui.notifications.warn("You don't own this character.");
    let app = open.get(actor.id);
    if (!app || app.state === ApplicationV2.RENDER_STATES.CLOSED) { app = new LevelUpApp(actor); open.set(actor.id, app); }
    app.render({ force: true });
    return app;
}
