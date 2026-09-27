import { fsBar, fsStyle, handleTextSizeClick } from "./textsize.mjs";
import { ATTRS, ATTR_LABEL, ForgeData, localize, plainText, priceCredits } from "./data.mjs";
import { blankState, derive } from "./model.mjs";
import { blankPlan, ctxFromCreator, deriveLevel } from "./levels.mjs";
import { CUSTOM, blankCustom, homebrewAllowed, mixedForm, backgroundForm, ancestryForm, setCustom } from "./custom.mjs";
import { qualifier, creatorNames } from "./prereq.mjs";
import { handleLevelEvent, renderSection, sectionsFor } from "./levelui.mjs";
export const MAX_START_LEVEL = 3;
import { createCharacter } from "./create.mjs";
import { importBuild, MAX_IMPORT_LEVEL } from "./import.mjs";
import { requestGMCreate, canCreateLocally, gmOnline } from "./relay.mjs";

const MODULE_ID = "sf2e-character-forge";

/** Optional "support" link, set in module.json under flags.sf2e-character-forge.donate. Hidden when empty. */
export function supportLink() {
    const url = game.modules.get(MODULE_ID)?.flags?.[MODULE_ID]?.donate;
    if (!url || !/^https:\/\//.test(url)) return "";
    return `<a class="support" href="${esc(url)}" target="_blank" rel="noopener"><i class="fa-solid fa-mug-hot"></i> Enjoying the Forge? Buy me a coffee</a>`;
}
const { ApplicationV2 } = foundry.applications.api;

const STEPS = [
    ["ancestry", "Ancestry"], ["background", "Background"], ["class", "Class"], ["attributes", "Attributes"],
    ["skills", "Skills & Languages"], ["feats", "Feats"], ["spells", "Spells"], ["gear", "Gear"], ["review", "Details & Create"],
];

let SHARED_DATA = null;
export function sharedData() { return (SHARED_DATA ??= new ForgeData()); }

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sgn = (n) => (n >= 0 ? "+" : "") + n;
const uniq = (a) => [...new Set(a.filter(Boolean))];

/** Keep description HTML but flatten enricher syntax into readable labels */
export function descHTML(html, max = 0) {
    if (!html) return "";
    let s = String(html)
        .replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "<em>$1</em>")
        .replace(/@UUID\[[^\]]*?\.([^.\]]+)\]/g, "<em>$1</em>")
        .replace(/@(Check|Damage|Template|Localize)\[([^\]]*)\](\{([^}]*)\})?/g, (m, t, a, b, label) => esc(label || a.split("|")[0]))
        .replace(/\[\[\/[^\]]*\]\](\{([^}]*)\})?/g, (m, b, label) => esc(label || ""))
        .replace(/<(script|iframe|style)[\s\S]*?<\/\1>/gi, "");
    if (max) { const txt = plainText(s); if (txt.length > max) return `<p>${esc(plainText(s, max))}</p>`; }
    return s;
}
const rarityTag = (r) => (r && r !== "common" ? `<span class="tag ${esc(r)}">${esc(r)}</span>` : "");
const pubOf = (x) => x?.system?.publication?.title ?? "";

export class CharacterForgeApp extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "sf2e-character-forge",
        classes: ["sf2e-forge"],
        tag: "div",
        window: { title: "Character Forge", icon: "fa-solid fa-user-astronaut", resizable: true },
        position: { width: 1200, height: 820 },
    };

    constructor(options = {}) {
        super(options);
        this.data = sharedData();
        this.S = this.#loadDraft();
        this.step = "ancestry";
        this.q = {};
        this.progress = { msg: "Reading compendiums…", pct: 0 };
        this.prefs = this.#loadPrefs();
        this.busy = false;
        this.confirmNew = 0;
    }

    /* ------------------------- persistence ------------------------- */
    get #draftKey() { return `${MODULE_ID}.draft.${game.world?.id}.${game.user?.id}`; }
    #loadDraft() {
        try { const raw = localStorage.getItem(this.#draftKey); if (raw) return foundry.utils.mergeObject(blankState(), JSON.parse(raw)); } catch (e) { /* ignore */ }
        return blankState();
    }
    #saveDraft() { try { localStorage.setItem(this.#draftKey, JSON.stringify(this.S)); } catch (e) { /* ignore */ } }
    #loadPrefs() {
        try { return Object.assign({ hideRare: false, sources: null, highLevelGear: false }, JSON.parse(localStorage.getItem(`${MODULE_ID}.prefs`) || "{}")); } catch (e) { return { hideRare: false, sources: null, highLevelGear: false }; }
    }
    #savePrefs() { try { localStorage.setItem(`${MODULE_ID}.prefs`, JSON.stringify(this.prefs)); } catch (e) { /* ignore */ } }
    /** Starting level: 1-3 for new builds, up to 20 for imported characters */
    startLevel() { return Math.min(this.S.imported ? MAX_IMPORT_LEVEL : MAX_START_LEVEL, Math.max(1, Number(this.S.level) || 1)); }
    showHomebrew() { return !!this.prefs.showHomebrew && (homebrewAllowed() || game.user.isGM); }
    visible(x, selected) {
        if (selected) return true;
        const r = x.system?.traits?.rarity ?? "common";
        if (this.prefs.hideRare && r !== "common") return false;
        const src = this.prefs.sources;
        if (src && src.length && !src.includes(pubOf(x) || "Other")) return false;
        return true;
    }

    /* ------------------------- rendering ------------------------- */
    async _prepareContext() {
        if (!this.data.ready) return { loading: true };
        const D = await derive(this.data, this.S);
        this.D = D;
        this.Q = qualifier(this.data, { ranks: Object.fromEntries(this.data.skills.map((s) => [s.slug, D.trained.has(s.slug) ? 1 : 0])), lores: D.lores.map((n) => ({ name: n, rank: 1 })), mods: D.mod, level: 1, names: creatorNames(D), vision: D.anc?.system?.vision });
        // Levels above 1 (starting higher than 1st level)
        this.LV = {};
        const target = this.startLevel();
        if (D.cls) {
            for (let L = 2; L <= target; L++) {
                const plan = (this.S.levels[L] ??= blankPlan());
                const LV = await deriveLevel(this.data, ctxFromCreator(this.data, this.S, D, L), plan, (x, sel) => this.visible(x, sel));
                this.LV[L] = LV;
                for (const [, msg] of LV.issues) D.issues.push([`level${L}`, `Level ${L}: ${msg}`]);
            }
        } else if (target > 1) D.issues.push(["class", "Choose a class to plan your higher levels."]);
        if (this.bonusPreview) await this.data.doc(this.bonusPreview);
        return { loading: false, D };
    }

    async _renderHTML(context) {
        if (context.loading) {
            return `<div class="forge-root" style="${fsStyle()}"><div class="forge-loading"><div class="bar"><span style="width:${Math.round(this.progress.pct * 100)}%"></span></div><p>${esc(this.progress.msg)}</p></div></div>`;
        }
        const D = context.D;
        const views = { ancestry: this.vAncestry, background: this.vBackground, class: this.vClass, attributes: this.vAttributes, skills: this.vSkills, feats: this.vFeats, spells: this.vSpells, gear: this.vGear, review: this.vReview };
        const steps = this.steps();
        if (this.step !== "import" && !steps.some((s) => s[0] === this.step)) this.step = "ancestry";
        const idx = steps.findIndex((s) => s[0] === this.step);
        const nav = `<div class="navbtns">${idx > 0 ? `<button type="button" class="btn" data-go="${steps[idx - 1][0]}"><i class="fa-solid fa-arrow-left"></i> ${steps[idx - 1][1]}</button>` : "<span></span>"}${idx < steps.length - 1 ? `<button type="button" class="btn primary" data-go="${steps[idx + 1][0]}">${steps[idx + 1][1]} <i class="fa-solid fa-arrow-right"></i></button>` : ""}</div>`;
        const view = this.step === "import" ? this.vImport() : this.step.startsWith("level") ? this.vLevel(D, Number(this.step.slice(5))) : views[this.step].call(this, D);
        return `<div class="forge-root" style="${fsStyle()}">
            <nav class="rail">${this.rail(D)}</nav>
            <section class="main" data-scroll="main">${this.step === "import" ? "" : this.importBanner()}${view}${this.step === "import" ? "" : nav}</section>
            <aside class="sheet" data-scroll="sheet">${this.sheet(D)}</aside>
        </div>`;
    }

    _replaceHTML(result, content) {
        const scrolls = {};
        content.querySelectorAll("[data-scroll]").forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });
        const focusId = document.activeElement?.id && content.contains(document.activeElement) ? document.activeElement.id : null;
        const selStart = focusId ? document.activeElement.selectionStart : null;
        content.innerHTML = result;
        content.querySelectorAll("[data-scroll]").forEach((el) => { if (scrolls[el.dataset.scroll] != null && !this._resetScroll) el.scrollTop = scrolls[el.dataset.scroll]; });
        this._resetScroll = false;
        if (focusId) { const el = content.querySelector(`#${CSS.escape(focusId)}`); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { /* ignore */ } } }
    }

    async _onFirstRender(context, options) {
        await super._onFirstRender?.(context, options);
        const root = this.element;
        root.addEventListener("click", (ev) => this.#onClick(ev));
        root.addEventListener("change", (ev) => this.#onChange(ev));
        root.addEventListener("input", (ev) => this.#onInput(ev));
        if (!this.data.ready) {
            this.data.load((msg, pct) => { this.progress = { msg, pct }; const el = this.element?.querySelector(".forge-loading"); if (el) { el.querySelector("p").textContent = msg; el.querySelector(".bar span").style.width = `${Math.round(pct * 100)}%`; } })
                .then(() => this.render())
                .catch((err) => { console.error(err); ui.notifications.error("Character Forge couldn't read your compendiums. Press F12 and check the console for details."); });
        }
    }

    steps() {
        const s = STEPS.slice(0, 7).map((x) => [...x]);
        const target = this.startLevel();
        for (let L = 2; L <= target; L++) s.push([`level${L}`, `Level ${L}`]);
        return [...s, ...STEPS.slice(7)];
    }

    rail(D) {
        const status = (id) => {
            const list = D.issues.filter((i) => i[0] === id && i[2] !== "info");
            if (id === "spells" && !D.caster) return "ok";
            if (["ancestry", "background", "class"].includes(id) && D.issues.some((i) => i[0] === id && /^Choose an? (ancestry|background|class)\.$/.test(i[1]))) return "bad";
            return list.length ? "warn" : "ok";
        };
        const srcTitles = this.#sourceTitles();
        const on = this.prefs.sources;
        const lvl = this.startLevel();
        const chips = Array.from({ length: MAX_START_LEVEL }, (_, i) => i + 1);
        if (lvl > MAX_START_LEVEL) chips.push(lvl);
        const lvlPick = `<div class="startlvl"><b>Starting level</b><div class="chips">${chips.map((n) => `<button type="button" class="chip ${n === lvl ? "on" : ""}" data-startlvl="${n}">${n}</button>`).join("")}</div></div>`;
        const imp = `<button type="button" class="step import ${this.step === "import" ? "on" : ""}" data-step="import"><span class="no"><i class="fa-solid fa-file-import"></i></span><span>Import a character</span></button>`;
        return fsBar() + lvlPick + imp + this.steps().map(([id, label], i) => `<button type="button" class="step ${this.step === id ? "on" : ""}" data-step="${id}"><span class="no">${String(i + 1).padStart(2, "0")}</span><span>${label}</span><span class="dot ${status(id)}"></span></button>`).join("")
            + `<div class="prefs"><b>Options shown</b>
                ${game.user.isGM ? `<label title="Lets players make their own ancestry or background"><input type="checkbox" data-hbworld="1" ${homebrewAllowed() ? "checked" : ""}> Allow homebrew for players</label>` : ""}
                <label title="${homebrewAllowed() || game.user.isGM ? "Adds Custom ancestry and Custom background to the lists" : "Your GM has turned homebrew off"}"><input type="checkbox" data-pref="showHomebrew" ${this.showHomebrew() ? "checked" : ""} ${homebrewAllowed() || game.user.isGM ? "" : "disabled"}> Make custom ancestry / background${homebrewAllowed() || game.user.isGM ? "" : " (off by GM)"}</label>
                <label><input type="checkbox" data-pref="hideUnmet" ${this.prefs.hideUnmet !== false ? "checked" : ""}> Hide feats I don't qualify for</label>
                <label><input type="checkbox" data-pref="hideRare" ${this.prefs.hideRare ? "checked" : ""}> Hide uncommon &amp; rare</label>
                <details><summary>Books (${on && on.length ? on.length : "all"})</summary>${srcTitles.map((t) => `<label><input type="checkbox" data-src="${esc(t)}" ${!on || !on.length || on.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}</details>
            </div>${supportLink()}`;
    }

    #sourceTitles() {
        this._titles ??= uniq([...this.data.ancestries, ...this.data.backgrounds, ...this.data.heritages].map((d) => pubOf(d) || "Other")).sort();
        return this._titles;
    }

    sheet(D) {
        const S = this.S;
        const line = [D.her?.name ?? D.anc?.name, D.bg?.name, D.cls?.name].filter(Boolean).join(" · ");
        const skills = this.data.skills.filter((s) => D.trained.has(s.slug));
        const issues = D.issues.filter((i) => i[2] !== "info");
        const info = D.issues.filter((i) => i[2] === "info");
        return `<div class="sh-head"><div class="nm">${esc(S.name || "Unnamed character")}</div><div class="ln">${esc(line || "Start with an ancestry, background and class")}</div></div>
            <div class="vitals"><div><b>${D.hp == null ? "—" : D.hp + Object.values(this.LV ?? {}).reduce((n, lv) => n + lv.hpGain, 0)}</b><span>HP at level ${this.startLevel()}</span></div><div><b>${D.key ? D.key.toUpperCase() : "—"}</b><span>Key</span></div><div><b>${D.credits}</b><span>Credits</span></div></div>
            <div class="attrs">${ATTRS.map((a) => `<div class="${D.key === a ? "key" : ""}" title="${ATTR_LABEL[a]}"><b>${sgn(D.mod[a])}</b><span>${a}</span></div>`).join("")}</div>
            <div class="sh-sec"><h4>Trained skills</h4><div class="rows">${skills.map((s) => `<span>${esc(s.label)}</span><span class="n">${sgn(D.mod[s.attribute] + 3)}</span>`).join("") || '<span class="note">None yet</span><span></span>'}${D.lores.map((l) => `<span>${esc(l)}</span><span class="n">${sgn(D.mod.int + 3)}</span>`).join("")}</div></div>
            <div class="sh-sec"><h4>To finish</h4>${issues.length ? `<div class="issues">${issues.map((i) => `<div class="issue">${esc(i[1])}</div>`).join("")}</div>` : '<div class="allgood">Ready to create.</div>'}
            ${info.length ? `<div class="issues info">${info.map((i) => `<div class="issue">${esc(i[1])}</div>`).join("")}</div>` : ""}</div>
            <div class="sh-sec note">The character sheet works out AC, saves and Strikes once the character is created.</div>`;
    }

    /* ------------------------- pickers ------------------------- */
    picker(key, items, sel, noun, detail, lv = null) {
        const q = (this.q[key] || "").toLowerCase();
        const hasQual = items.some((it) => it.qual);
        const hide = hasQual && this.prefs.hideUnmet !== false;
        let hidden = 0;
        const list = items.filter((it) => {
            if (q && !(it.name.toLowerCase().includes(q) || (it.sub || "").toLowerCase().includes(q))) return false;
            if (hide && it.qual?.status === "unmet" && it.value !== sel) { hidden++; return false; }
            return true;
        });
        const qnote = (it) => (it.qual?.status === "unmet" ? `Needs: ${it.qual.unmet.join("; ")}` : it.qual?.status === "unknown" ? `Check: ${it.qual.unknown.join("; ")}` : "");
        const qbar = hasQual ? `<div class="qbar"><span>${hide ? `Hiding ${hidden} you don't qualify for` : "Showing every feat"}</span><button type="button" class="btn sm ghost" data-qtoggle="1">${hide ? "Show all" : "Hide unqualified"}</button></div>` : "";
        const lis = list.map((it) => `<button type="button" class="pitem ${it.value === sel ? "sel" : ""} ${it.qual ? `q-${it.qual.status}` : ""}" title="${esc(qnote(it))}" ${lv ? `data-lvl="${lv.lvl}" data-lvpick="1" data-lvslot="${esc(lv.slot)}"` : `data-pick="${esc(key)}"`} data-v="${esc(it.value)}">${it.img ? `<img src="${esc(it.img)}" alt="">` : ""}<span class="pt"><span class="pn">${esc(it.name)}</span><span class="ps">${esc(qnote(it) || it.sub || "")}</span></span>${rarityTag(it.rarity)}</button>`).join("") || `<div class="pempty">${hidden ? `No feats you qualify for match. <button type="button" class="btn sm" data-qtoggle="1">Show all</button>` : "Nothing matches."}</div>`;
        return `<div class="picker"><div class="plist">${qbar}<input type="search" class="psearch" id="q-${esc(key)}" data-q="${esc(key)}" placeholder="Search ${items.length} ${esc(noun)}…" value="${esc(this.q[key] || "")}">
            <div class="pitems" data-scroll="pl-${esc(key)}">${lis}</div></div><div class="detail">${detail}</div></div>`;
    }
    docDetail(doc, eyebrow, extraTags = "") {
        if (!doc) return '<p class="note">Select an option to read its rules.</p>';
        return `<div class="eyebrow">${esc(eyebrow)}</div><h3>${esc(doc.name)} <a class="open-sheet" data-open="${esc(doc.uuid)}" title="Open item sheet"><i class="fa-solid fa-up-right-from-square"></i></a></h3>
            <div class="meta">${pubOf(doc) ? `<span class="tag">${esc(pubOf(doc))}</span>` : ""}${rarityTag(doc.system?.traits?.rarity)}${(doc.system?.traits?.value ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${extraTags}</div>
            <div class="rules">${descHTML(doc.system?.description?.value)}</div>`;
    }
    descHTML(h, m) { return descHTML(h, m); }
    choiceBlock(D, section) { return this.choiceNodes(D.choices.filter((n) => n.section === section)); }
    choiceNodes(nodes, lvl = null) {
        if (!nodes.length) return "";
        return `<div class="sub-h">Choices from these options</div><div class="slots">${nodes.map((n) => {
            const head = `<div class="slot-h"><b>${esc(n.prompt)}</b><span class="tag acc">${esc(n.itemName)}</span>${n.via ? `<span class="note">via ${esc(n.via)}</span>` : ""}</div>`;
            if (!n.options) return `<div class="slot">${head}<p class="note">You'll be asked this when the character is created.</p></div>`;
            if (!n.options.length) return `<div class="slot">${head}<p class="note">Your compendiums don't list options for this, so you'll be asked when the character is created.</p></div>`;
            const ans = n.answer;
            const opts = n.options.map((o) => `<option value="${esc(JSON.stringify(o.value))}" ${JSON.stringify(o.value) === JSON.stringify(ans) ? "selected" : ""}>${esc(o.label)}${o.rarity && o.rarity !== "common" ? ` (${o.rarity})` : ""}</option>`).join("");
            const chosen = n.options.find((o) => JSON.stringify(o.value) === JSON.stringify(ans));
            const chosenDoc = chosen?.uuid ? this.data.docCache.get(chosen.uuid) : null;
            return `<div class="slot">${head}<select ${lvl ? `data-lvl="${lvl}" data-lvanswer="${esc(n.key)}"` : `data-answer="${esc(n.key)}"`}><option value="">— choose —</option>${opts}</select>
                ${chosenDoc ? `<details><summary>Read ${esc(chosenDoc.name)}</summary><div class="rules">${descHTML(chosenDoc.system?.description?.value)}</div></details>` : ""}</div>`;
        }).join("")}</div>`;
    }

    /* ------------------------- steps ------------------------- */
    vAncestry(D) {
        const S = this.S;
        const items = this.data.ancestries.filter((a) => this.visible(a, a.uuid === S.anc)).map((a) => ({ value: a.uuid, name: a.name, img: a.img, rarity: a.system.traits?.rarity, sub: `${pubOf(a)} · HP ${a.system.hp} · ${a.system.size}` }));
        if (this.showHomebrew() || S.anc === CUSTOM.ancestry) items.unshift({ value: CUSTOM.ancestry, name: "Custom ancestry", sub: "Homebrew · build your own", rarity: "homebrew" });
        const a = D.anc;
        const fmtB = (o) => Object.values(o ?? {}).map((b) => (b.value?.length === 1 ? ATTR_LABEL[b.value[0]] : "Free")).join(", ");
        const det = a?.custom ? ancestryForm(this.data, S.custom.ancestry) : a ? `${this.docDetail(a, "Ancestry")}<dl class="kv"><dt>Hit Points</dt><dd>${a.system.hp}</dd><dt>Size</dt><dd>${esc(a.system.size)}</dd><dt>Speed</dt><dd>${a.system.speed} ft</dd><dt>Boosts</dt><dd>${fmtB(a.system.boosts)}</dd><dt>Flaws</dt><dd>${fmtB(a.system.flaws) || "None"}</dd><dt>Languages</dt><dd>${esc((a.system.languages?.value ?? []).map((l) => localize(CONFIG.PF2E.languages?.[l] ?? l)).join(", "))}</dd><dt>Vision</dt><dd>${esc(a.system.vision)}</dd></dl>` : this.docDetail(null);
        let html = `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 1</span><h2>Ancestry</h2></div>${this.picker("anc", items, S.anc, "ancestries", det)}</div>`;
        if (!a) return html;
        const slug = a.system.forgeFeatFrom ?? a.system.slug;
        const hs = this.data.heritages.filter((h) => (!h.system.ancestry || h.system.ancestry.slug === slug) && this.visible(h, h.uuid === S.her))
            .map((h) => ({ value: h.uuid, name: h.name, img: h.img, rarity: h.system.traits?.rarity, sub: `${h.system.ancestry ? "" : "Versatile · "}${pubOf(h)}` }))
            .sort((x, y) => (x.sub.startsWith("Versatile") - y.sub.startsWith("Versatile")) || x.name.localeCompare(y.name));
        hs.push({ value: CUSTOM.heritage, name: "Custom mixed heritage", sub: "Official rule · two ancestries · GM approval", rarity: "uncommon" });
        const herDet = D.her?.custom ? mixedForm(this.data, S.custom.mixed, a) : this.docDetail(D.her, "Heritage");
        html += `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 1b</span><h2>Heritage</h2></div>${this.picker("her", hs, S.her, "heritages", herDet)}</div>`;
        const pool = this.ancestryFeatPool(D);
        html += `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 1c</span><h2>Ancestry feat</h2></div>${this.picker("ancfeat", pool.map((f) => ({ value: f.uuid, name: f.name, rarity: f.system?.traits?.rarity, qual: this.Q?.(f), sub: pubOf(f) })), S.feats.anc, "feats", this.featDetail(D.featAnc, this.Q))}
            ${this.choiceBlock(D, "ancestry")}</div>`;
        return html;
    }
    ancestryFeatPool(D) {
        const a = D.anc; if (!a) return [];
        const traits = new Set([a.system.slug, a.system.forgeFeatFrom, ...(D.her?.system?.traits?.value ?? []), ...(D.her && !D.her.system.ancestry ? [D.her.system.slug] : [])]);
        return this.data.feats.filter((f) => f.system?.category === "ancestry" && (f.system?.level?.value ?? 1) === 1
            && ((f.system?.traits?.value ?? []).some((t) => traits.has(t)) || ((f.system?.traits?.value ?? []).length === 1 && f.system.traits.value[0] === "ancestry"))
            && this.visible(f, f.uuid === this.S.feats.anc));
    }
    featDetail(doc, check = null) {
        if (!doc) return '<p class="note">Pick a feat to read it.</p>';
        const pre = (doc.system?.prerequisites?.value ?? []).map((p) => p.value).filter(Boolean);
        const qual = check ? check(doc) : null;
        const box = !pre.length ? "" : !qual ? `<p class="warnbox"><b>Prerequisites:</b> ${esc(pre.join("; "))}</p>`
            : qual.status === "met" ? `<p class="okbox"><b>Prerequisites met:</b> ${esc(pre.join("; "))}</p>`
            : qual.status === "unmet" ? `<p class="badbox"><b>You don't meet:</b> ${esc(qual.unmet.join("; "))}${qual.unknown.length ? `<br><b>Also check:</b> ${esc(qual.unknown.join("; "))}` : ""}</p>`
            : `<p class="warnbox"><b>Check with your GM:</b> ${esc(qual.unknown.join("; "))}</p>`;
        return box + this.docDetail(doc, `Feat ${doc.system?.level?.value ?? ""}`);
    }
    vBackground(D) {
        const S = this.S;
        const items = this.data.backgrounds.filter((b) => this.visible(b, b.uuid === S.bg)).map((b) => ({ value: b.uuid, name: b.name, img: b.img, rarity: b.system.traits?.rarity, sub: `${Object.values(b.system.boosts ?? {}).filter((x) => x.value?.length < 6).map((x) => x.value.map((v) => v.toUpperCase()).join("/")).join(" ")} · ${(b.system.trainedSkills?.value ?? []).map((s) => localize(CONFIG.PF2E.skills?.[s]?.label ?? s)).join(", ")}` }));
        if (this.showHomebrew() || S.bg === CUSTOM.background) items.unshift({ value: CUSTOM.background, name: "Custom background", sub: "Homebrew · build your own", rarity: "homebrew" });
        const det = D.bg?.custom ? backgroundForm(this.data, S.custom.background) : this.docDetail(D.bg, "Background");
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 2</span><h2>Background</h2></div>${this.picker("bg", items, S.bg, "backgrounds", det)}${this.choiceBlock(D, "background")}</div>`;
    }
    vClass(D) {
        const S = this.S;
        const items = this.data.classes.filter((c) => this.visible(c, c.uuid === S.cls)).map((c) => ({ value: c.uuid, name: c.name, img: c.img, sub: `HP ${c.system.hp} · Key ${(c.system.keyAbility?.value ?? []).map((k) => k.toUpperCase()).join("/")}` }));
        let html = `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 3</span><h2>Class</h2></div>${this.picker("cls", items, S.cls, "classes", this.docDetail(D.cls, "Class"))}</div>`;
        if (!D.cls) return html;
        html += `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 3b</span><h2>${esc(D.cls.name)} options</h2></div>`;
        if (D.keyOptions.length > 1) html += `<div class="sub-h">Key attribute</div><div class="chips">${D.keyOptions.map((k) => `<button type="button" class="chip ${D.key === k ? "on" : ""}" data-key="${k}">${ATTR_LABEL[k]}</button>`).join("")}</div>`;
        html += this.choiceBlock(D, "class");
        html += `<div class="sub-h">1st-level class features</div><div class="slots">${D.features.map((f) => `<details class="slot"><summary><b>${esc(f.name)}</b></summary><div class="rules">${descHTML(f.system?.description?.value)}</div></details>`).join("")}</div></div>`;
        return html;
    }
    vAttributes(D) {
        const S = this.S, a = D.anc, bg = D.bg;
        const rows = [];
        const cell = (row, k, cls, txt, dis, slot = "") => `<td><button type="button" class="bx ${cls}" ${dis ? "disabled" : ""} data-boost="${row}" data-attr="${k}" data-slot="${slot}">${txt}</button></td>`;
        if (a) {
            if (S.alt) {
                rows.push(`<tr><td class="src">Ancestry<small>${esc(a.name)} · two free boosts</small></td>${ATTRS.map((k) => { const on = S.altBoosts.includes(k); return cell("alt", k, on ? "on" : "", on ? "+1" : "", !on && S.altBoosts.length >= 2); }).join("")}</tr>`);
            } else {
                const fixed = Object.values(a.system.boosts ?? {}).filter((b) => b.value?.length === 1).map((b) => b.value[0]);
                const flaws = Object.values(a.system.flaws ?? {}).filter((b) => b.value?.length === 1).map((b) => b.value[0]);
                for (const [slot, b] of Object.entries(a.system.boosts ?? {})) {
                    if ((b.value ?? []).length <= 1) continue;
                    const taken = Object.entries(S.ancSel).filter(([s]) => s !== slot).map(([, v]) => v);
                    rows.push(`<tr><td class="src">Ancestry<small>${esc(a.name)} · free boost</small></td>${ATTRS.map((k) => {
                        const on = S.ancSel[slot] === k;
                        if (fixed.includes(k)) return cell("anc", k, "fixed", "+1", true, slot);
                        if (!b.value.includes(k) || taken.includes(k)) return cell("anc", k, "", "", true, slot);
                        return cell("anc", k, on ? "on" : "", on ? "+1" : "", false, slot);
                    }).join("")}</tr>`);
                }
                if (flaws.length) rows.push(`<tr><td class="src">Ancestry flaw</td>${ATTRS.map((k) => (flaws.includes(k) ? cell("x", k, "flaw", "−1", true) : "<td></td>")).join("")}</tr>`);
                if (!Object.values(a.system.boosts ?? {}).some((b) => b.value?.length > 1)) rows.push(`<tr><td class="src">Ancestry<small>${esc(a.name)}</small></td>${ATTRS.map((k) => (fixed.includes(k) ? cell("x", k, "fixed", "+1", true) : "<td></td>")).join("")}</tr>`);
            }
        }
        if (bg) {
            for (const [slot, b] of Object.entries(bg.system.boosts ?? {})) {
                const opts = b.value ?? [];
                const taken = Object.entries(S.bgSel).filter(([s]) => s !== slot).map(([, v]) => v);
                rows.push(`<tr><td class="src">Background<small>${esc(bg.name)} · ${opts.length === 6 ? "free" : opts.map((o) => ATTR_LABEL[o]).join(" or ")}</small></td>${ATTRS.map((k) => {
                    const on = S.bgSel[slot] === k;
                    if (opts.length === 1) return opts[0] === k ? cell("x", k, "fixed", "+1", true) : "<td></td>";
                    return cell("bg", k, on ? "on" : "", on ? "+1" : "", !opts.includes(k) || taken.includes(k), slot);
                }).join("")}</tr>`);
            }
        }
        if (D.cls) rows.push(`<tr><td class="src">Class key attribute<small>${esc(D.cls.name)}${D.keyOptions.length > 1 ? " · choose on the Class step" : ""}</small></td>${ATTRS.map((k) => (k === D.key ? cell("x", k, "fixed", "+1", true) : "<td></td>")).join("")}</tr>`);
        rows.push(`<tr><td class="src">Four free boosts<small>Each to a different attribute</small></td>${ATTRS.map((k) => { const on = S.free.includes(k); return cell("free", k, on ? "on" : "", on ? "+1" : "", !on && S.free.length >= 4); }).join("")}</tr>`);
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 4</span><h2>Attribute modifiers</h2></div>
            <p class="lede">Every attribute starts at +0. Each boost adds 1 and each flaw subtracts 1. Boosts from one source go to different attributes.</p>
            ${a ? `<label class="toggle"><input type="checkbox" data-alt="1" ${S.alt ? "checked" : ""}> Alternate ancestry boosts (two free boosts, no flaws)</label>` : ""}
            <div class="tablewrap"><table class="btable"><thead><tr><th>Source</th>${ATTRS.map((k) => `<th>${k}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>
            <tfoot><tr><td>Modifier</td>${ATTRS.map((k) => `<td class="${D.mod[k] > 0 ? "pos" : D.mod[k] < 0 ? "neg" : ""}">${sgn(D.mod[k])}</td>`).join("")}</tr></tfoot></table></div>
            <p class="note">A few heritages (like Korasha Lashunta) swap a boost or flaw. Make that change in the sheet's attribute builder after the character is created.</p></div>`;
    }
    vSkills(D) {
        const S = this.S;
        const left = D.skillPicks - D.chosenSkills.length;
        const rows = this.data.skills.map((s) => {
            const auto = D.autoSkills[s.slug];
            const on = D.trained.has(s.slug);
            return `<tr><td><span class="prof ${on ? "T" : "U"}">${on ? "T" : "U"}</span></td><td><label class="toggle"><input type="checkbox" data-skill="${s.slug}" ${on ? "checked" : ""} ${auto || !D.cls || (!on && left <= 0) ? "disabled" : ""}> ${esc(s.label)}</label> <span class="why">${s.attribute.toUpperCase()}${auto ? " · " + esc(uniq(auto).join(", ")) : ""}</span></td><td class="mod">${sgn(D.mod[s.attribute] + (on ? 3 : 0))}</td></tr>`;
        }).join("");
        const lores = D.lores.map((l) => `<tr><td><span class="prof T">T</span></td><td>${esc(l)} ${S.lores.some((x) => (/lore$/i.test(x) ? x : `${x} Lore`) === l) ? `<button type="button" class="btn sm ghost" data-dellore="${esc(l)}">Remove</button>` : '<span class="why">Background</span>'}</td><td class="mod">${sgn(D.mod.int + 3)}</td></tr>`).join("");
        const extraL = S.langs.filter((l) => !D.langBase.includes(l));
        const lLeft = D.langPicks - extraL.length;
        const langs = this.data.languages.filter((l) => !D.langBase.includes(l.slug)).map((l) => `<button type="button" class="chip ${S.langs.includes(l.slug) ? "on" : ""}" data-lang="${l.slug}" ${!S.langs.includes(l.slug) && lLeft <= 0 ? "disabled" : ""}>${esc(l.label)}</button>`).join("");
        const cnt = (a, b) => `<span class="count ${a === b ? "ok" : a > b ? "bad" : "warn"}">${a} / ${b}</span>`;
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 5</span><h2>Skills</h2></div>
            <p class="lede">Skills from your background, class and subclass are trained automatically. When two sources train the same skill you get an extra pick.</p>
            <div class="sub-h">Free skill picks ${cnt(D.chosenSkills.length, D.skillPicks)}</div>
            ${!D.cls ? '<p class="warnbox">Choose a class first.</p>' : ""}
            <table class="stable"><tbody>${rows}${lores}</tbody></table>
            <div class="inline"><input type="text" id="newLore" placeholder="Add a Lore skill (e.g. Starship)"><button type="button" class="btn sm" data-addlore="1">Add Lore</button></div></div>
            <div class="panel"><div class="panel-head"><span class="eyebrow">Step 5b</span><h2>Languages</h2></div>
            <p class="lede">You know ${esc(D.langBase.map((l) => localize(CONFIG.PF2E.languages?.[l] ?? l)).join(", ") || "your ancestry's languages")}.</p>
            <div class="sub-h">Additional languages ${cnt(extraL.length, D.langPicks)}</div><div class="chips">${langs}</div></div>`;
    }
    vFeats(D) {
        const S = this.S;
        const sel = (key, title, pool, value) => {
            const doc = key === "anc" ? D.featAnc : D.featCls;
            return `<div class="sub-h">${esc(title)} <span class="count ${value ? "ok" : "warn"}">${value ? 1 : 0} / 1</span></div>${this.picker(key === "anc" ? "ancfeat" : "clsfeat", pool.map((f) => ({ value: f.uuid, name: f.name, rarity: f.system?.traits?.rarity, qual: this.Q?.(f), sub: pubOf(f) })), value, "feats", this.featDetail(doc, this.Q))}`;
        };
        let html = `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 6</span><h2>Feats</h2></div>
            <p class="lede">At 1st level you get an ancestry feat and, for most classes, a class feat. Your background's skill feat is added automatically. Feats you don't qualify for are hidden. Red means a prerequisite isn't met; amber means it's something to check with your GM.</p><div>`;
        if (D.anc) html += sel("anc", `Ancestry feat (${D.anc.name})`, this.ancestryFeatPool(D), S.feats.anc);
        else html += '<p class="warnbox">Choose an ancestry first.</p>';
        if (D.hasClassFeat) {
            const trait = D.cls.system.slug;
            const pool = this.data.feats.filter((f) => f.system?.category === "class" && (f.system?.level?.value ?? 1) === 1 && (f.system?.traits?.value ?? []).includes(trait) && this.visible(f, f.uuid === S.feats.cls));
            html += sel("cls", `${D.cls.name} feat`, pool, S.feats.cls);
        } else if (D.cls) html += `<p class="note">${esc(D.cls.name)}s gain their first class feat at 2nd level.</p>`;
        html += `</div>${this.choiceBlock(D, "feats")}<div class="sub-h">Other bonus feats</div>
            <p class="note">Got a feat from somewhere the Forge doesn't track, like Sniper's bonus feat, Warblood Vesk or a reward from your GM? Find it here, read it, then add it.</p>
            ${this.picker("bonus", this.data.feats.filter((f) => f.system?.category !== "classfeature" && (f.system?.level?.value ?? 0) <= Math.max(1, Number(S.level) || 1) && this.visible(f, f.uuid === this.bonusPreview)).map((f) => ({ value: f.uuid, name: f.name, rarity: f.system?.traits?.rarity, qual: this.Q?.(f), sub: `${f.system?.category ?? ""} ${f.system?.level?.value ?? ""}` })), this.bonusPreview, "feats",
                this.bonusPreview ? `${this.featDetail(this.data.docCache.get(this.bonusPreview), this.Q)}<div class="inline"><button type="button" class="btn primary sm" data-addfeat="1"><i class="fa-solid fa-plus"></i> Add as bonus feat</button></div>` : '<p class="note">Select a feat on the left to see what it does.</p>')}
            <div class="slots" style="margin-top:10px">${D.extraFeats.map((f, i) => `<details class="slot"><summary class="slot-h"><b>${esc(f.name)}</b><span class="tag">Bonus</span>${rarityTag(f.system?.traits?.rarity)}<span class="spacer"></span><button type="button" class="btn sm ghost" data-delfeat="${i}">Remove</button></summary>${this.featDetail(f)}</details>`).join("")}</div></div>`;
        return html;
    }
    vSpells(D) {
        const S = this.S;
        if (!D.caster) return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 7</span><h2>Spells</h2></div><p class="lede">${D.cls ? `${esc(D.cls.name)}s don't cast spells at 1st level.` : "Pick a class first."}</p></div>`;
        if (!D.tradition) return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 7</span><h2>Spells</h2></div><p class="warnbox">Choose your connection or paradox on the Class step. It sets your tradition.</p></div>`;
        const t = D.tradition;
        const pool = (cantrip) => this.data.spells.filter((s) => {
            const tr = s.system?.traits ?? {};
            const isC = (tr.value ?? []).includes("cantrip");
            if ((tr.value ?? []).includes("focus")) return false;
            if (!(tr.traditions ?? []).includes(t)) return false;
            if (cantrip ? !isC : (isC || (s.system?.level?.value ?? 0) !== 1)) return false;
            const chosen = S.spells.cantrips.includes(s.uuid) || S.spells.first.includes(s.uuid);
            return this.visible(s, chosen);
        });
        const list = (key, arr, sel, max) => arr.map((s) => { const on = sel.includes(s.uuid); return `<tr><td><input type="checkbox" data-spell="${key}" data-v="${esc(s.uuid)}" ${on ? "checked" : ""} ${!on && sel.length >= max ? "disabled" : ""}></td><td><a data-open="${esc(s.uuid)}">${esc(s.name)}</a> ${rarityTag(s.system?.traits?.rarity)} <span class="why">${esc((s.system?.traits?.value ?? []).filter((x) => x !== "cantrip").join(", "))}</span></td></tr>`; }).join("");
        const granted = [D.grantedCantrip && `${D.grantedCantrip.name} (cantrip)`, D.grantedFirst && `${D.grantedFirst.name} (1st rank)`, D.focusSpell && `${D.focusSpell.name} (focus spell)`].filter(Boolean);
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 7</span><h2>Spell repertoire</h2><span class="tag acc">${esc(t)}</span></div>
            <p class="lede">You can cast three 1st-rank spells a day, plus cantrips as often as you like. Click a spell name to open it.</p>
            ${granted.length ? `<div class="okbox">Added automatically from ${esc(D.subDoc?.name ?? "your subclass")}: ${esc(granted.join(", "))}</div>` : ""}
            <div class="sub-h">Cantrips <span class="count ${S.spells.cantrips.length === 4 ? "ok" : "warn"}">${S.spells.cantrips.length} / 4</span></div>
            <div class="scrollbox" data-scroll="cantrips"><table class="stable"><tbody>${list("cantrips", pool(true), S.spells.cantrips, 4)}</tbody></table></div>
            <div class="sub-h">1st-rank spells <span class="count ${S.spells.first.length === 2 ? "ok" : "warn"}">${S.spells.first.length} / 2</span></div>
            <div class="scrollbox" data-scroll="first"><table class="stable"><tbody>${list("first", pool(false), S.spells.first, 2)}</tbody></table></div></div>`;
    }
    vGear(D) {
        const S = this.S;
        const lvlOk = (e) => this.prefs.highLevelGear || (e.system?.level?.value ?? 0) <= 1;
        const eq = this.data.equipment.filter((e) => lvlOk(e) && this.visible(e));
        const cr = (e) => priceCredits(e.system?.price);
        const opt = (e) => `<option value="${esc(e.uuid)}">${esc(e.name)} · ${cr(e)} cr${e.system?.level?.value ? ` · lvl ${e.system.level.value}` : ""}</option>`;
        const byType = (t) => eq.filter((e) => e.type === t);
        const armorOpts = byType("armor").map((e) => `<option value="${esc(e.uuid)}" ${e.uuid === S.gear.armor ? "selected" : ""}>${esc(e.name)} · ${esc(e.system?.category ?? "")}, AC +${e.system?.acBonus ?? 0} · ${cr(e)} cr</option>`).join("");
        const shieldOpts = byType("shield").map((e) => `<option value="${esc(e.uuid)}" ${e.uuid === S.gear.shield ? "selected" : ""}>${esc(e.name)} · +${e.system?.acBonus ?? 0} AC · ${cr(e)} cr</option>`).join("");
        const wGroups = {};
        for (const w of byType("weapon")) { const g = `${w.system?.category ?? "other"} ${w.system?.range ? "ranged" : "melee"}`; (wGroups[g] ??= []).push(w); }
        const wOpts = Object.entries(wGroups).sort().map(([g, ws]) => `<optgroup label="${esc(g)}">${ws.map(opt).join("")}</optgroup>`).join("");
        const gGroups = {};
        for (const g of eq.filter((e) => ["equipment", "consumable", "ammo", "backpack"].includes(e.type))) (gGroups[g.type] ??= []).push(g);
        const gOpts = Object.entries(gGroups).map(([t, gs]) => `<optgroup label="${esc(t)}">${gs.map(opt).join("")}</optgroup>`).join("");
        const row = (list, key) => list.map((it, i) => { const e = this.data.entry(it.uuid); if (!e) return ""; return `<tr><td><a data-open="${esc(e.uuid)}">${esc(e.name)}</a></td><td class="r"><input type="number" min="1" value="${it.q}" data-qty="${key}" data-i="${i}"></td><td class="r">${Math.round(cr(e) * it.q * 10) / 10}</td><td class="r"><button type="button" class="btn sm ghost" data-del="${key}" data-i="${i}">Remove</button></td></tr>`; }).join("");
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 8</span><h2>Gear</h2><span class="tag ${D.credits < 0 ? "rare" : "acc"}">${D.credits} of ${D.startCredits} credits left</span><span class="tag">${D.bulk} / ${D.bulkLimit} Bulk</span></div>
            <p class="lede">A 1st-level character starts with 150 credits. When starting at a higher level, use what your GM allows. Whatever you don't spend goes on a credstick.</p>
            <div class="inline"><label for="startCredits">Starting credits</label><input type="number" id="startCredits" min="0" step="10" value="${D.startCredits}" data-credits="1" style="width:110px"></div>
            <label class="toggle"><input type="checkbox" data-pref="highLevelGear" ${this.prefs.highLevelGear ? "checked" : ""}> Show items above level 1</label>
            <div class="grid2"><div class="field"><label>Armor (worn)</label><select data-gear="armor"><option value="">None</option>${armorOpts}</select></div>
            <div class="field"><label>Shield</label><select data-gear="shield"><option value="">None</option>${shieldOpts}</select></div></div>
            <div class="sub-h">Weapons</div><div class="inline"><select id="addWeapon"><option value="">— add a weapon —</option>${wOpts}</select><button type="button" class="btn sm" data-add="weapons">Add</button></div>
            ${S.gear.weapons.length ? `<table class="inv"><tbody>${row(S.gear.weapons, "weapons")}</tbody></table>` : ""}
            <div class="sub-h">Other equipment</div><div class="inline"><select id="addGear"><option value="">— add equipment —</option>${gOpts}</select><button type="button" class="btn sm" data-add="items">Add</button></div>
            ${S.gear.items.length ? `<table class="inv"><tbody>${row(S.gear.items, "items")}</tbody></table>` : ""}</div>`;
    }
    vLevel(D, L) {
        const LV = this.LV?.[L];
        if (!LV) return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>Level ${L}</h2></div><p class="warnbox">Pick a class first; it decides what you gain at each level.</p></div>`;
        return sectionsFor(LV).map(([sec]) => renderSection(this, LV, sec)).join("");
    }
    vReview(D) {
        const S = this.S;
        const f = (id, label) => `<div class="field"><label for="f-${id}">${label}</label><input type="text" id="f-${id}" data-bind="${id}" value="${esc(S[id])}"></div>`;
        const blocking = D.issues.filter((i) => i[2] !== "info");
        const local = canCreateLocally();
        const canCreate = local || gmOnline();
        const prompts = D.unanswered.map((n) => `<li>${esc(n.itemName)}: ${esc(n.prompt)}</li>`).join("");
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Step 9</span><h2>Details</h2></div>
            <div class="grid2">${f("name", "Character name")}${f("gender", "Pronouns / gender")}${f("age", "Age")}</div>
            <div class="field"><label for="f-notes">Backstory</label><textarea id="f-notes" data-bind="notes">${esc(S.notes)}</textarea></div></div>
            <div class="panel"><div class="panel-head"><span class="eyebrow">Create</span><h2>Build the actor</h2></div>
            ${blocking.length ? `<div class="warnbox">${blocking.length} thing${blocking.length > 1 ? "s" : ""} still open (listed on the right). You can create anyway and finish on the sheet.</div>` : '<div class="okbox">All set.</div>'}
            ${prompts ? `<p class="note">You'll be asked about these while the character is built:</p><ul class="note">${prompts}</ul>` : ""}
            ${local ? "" : canCreate ? '<p class="note">Your GM\'s Foundry builds the character and hands it to you. Any questions that come up appear on the GM\'s screen.</p>' : '<p class="warnbox">A GM needs to be logged in to build your character. Your choices are saved; come back when they\'re online.</p>'}
            <div class="inline"><button type="button" class="btn primary big" data-create="1" ${this.busy || !canCreate ? "disabled" : ""}><i class="fa-solid fa-user-plus"></i> ${this.busy ? "Creating…" : "Create character"}</button>
            <button type="button" class="btn" data-new="1">${Date.now() - this.confirmNew < 4000 ? "Click again to clear" : "Start over"}</button></div></div>`;
    }

    /* ------------------------- events ------------------------- */
    async #update(fn, { resetScroll = false } = {}) {
        fn(this.S);
        this.#saveDraft();
        this._resetScroll = resetScroll;
        await this.render();
    }

    async #onClick(ev) {
        if (handleTextSizeClick(ev)) return;
        if (handleLevelEvent(ev, (L) => (this.S.levels[L] ??= blankPlan()), () => { this.#saveDraft(); this.render(); })) return;
        const t = ev.target.closest("button, a[data-open]");
        if (!t || !this.element.contains(t)) return;
        const d = t.dataset;
        if (d.open) { ev.preventDefault(); (await fromUuid(d.open))?.sheet?.render(true); return; }
        if (d.step || d.go) { this.step = d.step || d.go; this._resetScroll = true; return this.render(); }
        if (d.qtoggle) { this.prefs.hideUnmet = this.prefs.hideUnmet === false; this.#savePrefs(); return this.render(); }
        if (d.pick === "bonus") { this.bonusPreview = this.bonusPreview === d.v ? "" : d.v; return this.render(); }
        if (d.pick) return this.#pick(d.pick, d.v);
        if (d.custset) return this.#update((S) => { S.custom = foundry.utils.mergeObject(blankCustom(), S.custom ?? {}); setCustom(S.custom, d.custset, d.v); });
        if (d.startlvl) return this.#update((S) => { S.level = Number(d.startlvl); });
        if (d.key) return this.#update((S) => { S.key = S.key === d.key ? "" : d.key; });
        if (d.boost) return this.#boost(d.boost, d.attr, d.slot);
        if (d.lang) return this.#update((S) => { S.langs = S.langs.includes(d.lang) ? S.langs.filter((x) => x !== d.lang) : [...S.langs, d.lang]; });
        if (d.addlore) { const v = this.element.querySelector("#newLore")?.value.trim(); if (v) return this.#update((S) => S.lores.push(v)); return; }
        if (d.dellore) return this.#update((S) => { S.lores = S.lores.filter((x) => (/lore$/i.test(x) ? x : `${x} Lore`) !== d.dellore); });
        if (d.addfeat) { const v = this.bonusPreview; if (v) { this.bonusPreview = ""; return this.#update((S) => { if (!S.extra.includes(v)) S.extra.push(v); }); } return; }
        if (d.delfeat !== undefined) return this.#update((S) => S.extra.splice(Number(d.delfeat), 1));
        if (d.add) {
            const v = this.element.querySelector(d.add === "weapons" ? "#addWeapon" : "#addGear")?.value;
            if (v) return this.#update((S) => { const list = S.gear[d.add]; const ex = list.find((x) => x.uuid === v); if (ex) ex.q++; else list.push({ uuid: v, q: 1 }); });
            return;
        }
        if (d.del) return this.#update((S) => S.gear[d.del].splice(Number(d.i), 1));
        if (d.create) return this.#create();
        if (d.doimport) return this.#import();
        if (d.impdismiss) return this.#update((S) => { if (S.imported) S.imported.dismissed = true; });
        if (d.new) {
            if (Date.now() - this.confirmNew > 4000) { this.confirmNew = Date.now(); return this.render(); }
            this.confirmNew = 0; this.step = "ancestry"; this.q = {};
            return this.#update((S) => Object.assign(S, blankState()), { resetScroll: true });
        }
    }

    async #onChange(ev) {
        if (ev.target?.dataset?.impfile) {
            const file = ev.target.files?.[0];
            if (file) { this.importError = ""; return this.#import(await file.text()); }
            return;
        }
        if (handleLevelEvent(ev, (L) => (this.S.levels[L] ??= blankPlan()), () => { this.#saveDraft(); this.render(); })) return;
        const t = ev.target, d = t.dataset;
        if (d.cust) return this.#update((S) => { S.custom = foundry.utils.mergeObject(blankCustom(), S.custom ?? {}); setCustom(S.custom, d.cust, t.value); });
        if (d.hbworld) { await game.settings.set("sf2e-character-forge", "allowHomebrew", t.checked); return this.render(); }
        if (d.credits !== undefined) return this.#update((S) => { S.startCredits = Math.max(0, Number(t.value) || 0); });
        if (d.pref) { this.prefs[d.pref] = t.checked; this.#savePrefs(); return this.render(); }
        if (d.src !== undefined) {
            const all = this.#sourceTitles();
            let on = this.prefs.sources && this.prefs.sources.length ? [...this.prefs.sources] : [...all];
            on = t.checked ? uniq([...on, d.src]) : on.filter((x) => x !== d.src);
            this.prefs.sources = on.length === all.length ? null : on;
            this.#savePrefs(); return this.render();
        }
        if (d.alt) return this.#update((S) => { S.alt = t.checked; S.ancSel = {}; S.altBoosts = []; });
        if (d.skill) return this.#update((S) => { S.skills = t.checked ? uniq([...S.skills, d.skill]) : S.skills.filter((x) => x !== d.skill); });
        if (d.feat) return this.#update((S) => { S.feats[d.feat] = t.value; });
        if (d.answer) return this.#update((S) => { if (t.value === "") delete S.answers[d.answer]; else S.answers[d.answer] = JSON.parse(t.value); });
        if (d.spell) return this.#update((S) => { const arr = S.spells[d.spell]; S.spells[d.spell] = t.checked ? uniq([...arr, d.v]) : arr.filter((x) => x !== d.v); });
        if (d.gear) return this.#update((S) => { S.gear[d.gear] = t.value; });
        if (d.qty) return this.#update((S) => { S.gear[d.qty][Number(d.i)].q = Math.max(1, parseInt(t.value) || 1); });
    }

    /* ------------------------- import ------------------------- */
    vImport() {
        const err = this.importError ? `<p class="badbox">${esc(this.importError)}</p>` : "";
        return `<div class="panel"><div class="panel-head"><span class="eyebrow">Import</span><h2>Bring in a character</h2></div>
            <p class="lede">Built someone in <a href="https://sf2e.hephaistos.online/" target="_blank" rel="noopener">Hephaistos 2E</a>? Open the character there, click the download button at the top left, and choose <b>Pathmuncher</b>. Then load that file here.</p>
            <p class="lede">Files exported from the Forge, and Pathbuilder-style JSON in general, work too.</p>
            <div class="imp-grid">
                <label class="imp-file"><i class="fa-solid fa-file-arrow-up"></i><span>Choose a .json file</span><input type="file" accept=".json,application/json" data-impfile="1"></label>
                <div class="imp-or">or paste it</div>
                <textarea id="imp-text" rows="8" placeholder='{"success":true,"build":{ ... }}'>${esc(this.importText ?? "")}</textarea>
            </div>
            ${err}
            <p class="note">Importing replaces the character you're building now. Nothing is created until you click Create on the last step, so you can check everything first.</p>
            <div class="inline"><button type="button" class="btn primary" data-doimport="1" ${this.busy ? "disabled" : ""}><i class="fa-solid fa-file-import"></i> ${this.busy ? "Importing…" : "Import"}</button></div></div>`;
    }

    importBanner() {
        const im = this.S.imported;
        if (!im || im.dismissed) return "";
        const items = [...(im.missing ?? []).map((m) => `Not found in your compendiums: ${m}`), ...(im.notes ?? [])];
        return `<div class="imp-banner"><div><b>Imported from ${esc(im.source)}${im.name ? `: ${esc(im.name)}` : ""}, level ${im.level}.</b>
            Go through each step and check the picks. Anything the Forge couldn't place is marked on the right.</div>
            ${items.length ? `<details><summary>${items.length} thing${items.length === 1 ? "" : "s"} to look at</summary><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></details>` : ""}
            <button type="button" class="x" data-impdismiss="1" title="Hide this">×</button></div>`;
    }

    /** Public entry point for the API: load JSON (object or string) as the current draft */
    async importFrom(json) {
        if (!this.data.ready) await new Promise((res) => { const t = setInterval(() => { if (this.data.ready) { clearInterval(t); res(); } }, 100); });
        this.step = "import";
        return this.#import(typeof json === "string" ? json : JSON.stringify(json));
    }

    async #import(given = null) {
        const text = given ?? this.element.querySelector("#imp-text")?.value ?? "";
        this.importText = text;
        this.importError = "";
        this.busy = true; await this.render();
        try {
            const { S, report } = await importBuild(this.data, text, { source: /"forge"\s*:/.test(text) ? "the Forge" : "Hephaistos" });
            this.S = S; this.importText = ""; this.step = "ancestry"; this.q = {}; this._resetScroll = true;
            this.#saveDraft();
            const n = report.missing.length + report.notes.length;
            ui.notifications.info(`Imported ${S.name || "the character"}.${n ? ` ${n} thing${n === 1 ? " needs" : "s need"} a look.` : ""}`);
        } catch (err) {
            console.error(err);
            this.importError = err.message || String(err);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    #onInput(ev) {
        const t = ev.target, d = t.dataset;
        if (d.q) {
            this.q[d.q] = t.value;
            clearTimeout(this._qt);
            this._qt = setTimeout(() => this.render(), 150);
            return;
        }
        if (d.bind) {
            this.S[d.bind] = t.value; this.#saveDraft();
            const nm = this.element.querySelector(".sh-head .nm"); if (nm && d.bind === "name") nm.textContent = t.value || "Unnamed character";
        }
    }

    #pick(key, v) {
        return this.#update((S) => {
            switch (key) {
                case "anc": if (S.anc !== v) { S.anc = v; S.her = ""; S.ancSel = {}; S.altBoosts = []; S.feats.anc = ""; S.langs = []; } break;
                case "her": S.her = S.her === v ? "" : v; break;
                case "ancfeat": S.feats.anc = S.feats.anc === v ? "" : v; break;
                case "clsfeat": S.feats.cls = S.feats.cls === v ? "" : v; break;
                case "bg": if (S.bg !== v) { S.bg = v; S.bgSel = {}; } break;
                case "cls": if (S.cls !== v) { S.cls = v; S.key = ""; S.feats.cls = ""; S.spells = { cantrips: [], first: [] }; } break;
            }
        });
    }

    #boost(row, attr, slot) {
        return this.#update((S) => {
            if (row === "anc") S.ancSel[slot] = S.ancSel[slot] === attr ? undefined : attr;
            else if (row === "bg") S.bgSel[slot] = S.bgSel[slot] === attr ? undefined : attr;
            else if (row === "alt") S.altBoosts = S.altBoosts.includes(attr) ? S.altBoosts.filter((x) => x !== attr) : [...S.altBoosts, attr].slice(0, 2);
            else if (row === "free") S.free = S.free.includes(attr) ? S.free.filter((x) => x !== attr) : S.free.length < 4 ? [...S.free, attr] : S.free;
            for (const o of [S.ancSel, S.bgSel]) for (const k of Object.keys(o)) if (!o[k]) delete o[k];
        });
    }

    async #create() {
        if (this.busy) return;
        this.busy = true; this.render();
        try {
            const actor = canCreateLocally()
                ? await createCharacter(this.data, this.S, this.D, { ownerId: game.user.id })
                : await requestGMCreate(this.S);
            if (actor) {
                ui.notifications.info(`${actor.name} created.`);
                try { localStorage.removeItem(this.#draftKey); } catch (e) { /* ignore */ }
                this.S = blankState();
                this.busy = false;
                await this.close();
                actor.sheet?.render(true);
                return;
            }
        } catch (err) {
            console.error("Character Forge | creation failed", err);
            ui.notifications.error(`Couldn't create the character: ${err.message}. Your choices are still here; press F12 and check the console for details.`);
        }
        this.busy = false; this.render();
    }
}
