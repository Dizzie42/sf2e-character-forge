/**
 * Shared UI for one level's choices. Used by the Level Up window and by the creator's "Level 2/3" steps.
 * The host app supplies picker(), featDetail(), choiceNodes(), and routes events to handleLevelEvent().
 */
import { ATTRS, ATTR_LABEL } from "./data.mjs";
import { ORD, RANK_LETTER, RANK_NAME, blankPlan } from "./levels.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rarityTag = (r) => (r && r !== "common" ? `<span class="tag ${esc(r)}">${esc(r)}</span>` : "");
const SLOT_LABEL = { class: "Class feat", skill: "Skill feat", general: "General feat", ancestry: "Ancestry feat" };
const SLOT_HELP = {
    class: "A feat from your class list, at your level or lower.",
    skill: "A feat with the skill trait. Most need a certain rank in a skill.",
    general: "Any general feat, including skill feats.",
    ancestry: "A feat from your ancestry or heritage list.",
};

export function gainChips(LV) {
    const g = LV.g, chips = [`<span class="tag acc">+${LV.hpGain} max HP</span>`];
    for (const s of LV.slots) chips.push(`<span class="tag acc">${SLOT_LABEL[s.key]}</span>`);
    if (g.skillIncrease) chips.push('<span class="tag acc">Skill increase</span>');
    if (g.boosts) chips.push('<span class="tag acc">4 attribute boosts</span>');
    for (const f of LV.features) chips.push(`<span class="tag acc">${esc(f.name)}</span>`);
    for (const r of LV.spellRanks) chips.push(`<span class="tag acc">${r.pick + (r.granted ? 1 : 0)} ${ORD[r.rank]}-rank spell${r.pick + (r.granted ? 1 : 0) > 1 ? "s" : ""}</span>`);
    chips.push('<span class="tag">+1 to all trained proficiencies</span>');
    return chips.join("");
}

export function sectionsFor(LV) {
    const s = [["overview", "Overview"]];
    if (LV.features.length) s.push(["features", "Class features"]);
    if (LV.slots.length) s.push(["feats", "Feats"]);
    if (LV.g.skillIncrease || LV.intUp) s.push(["skills", "Skill increase"]);
    if (LV.g.boosts) s.push(["boosts", "Attribute boosts"]);
    if (LV.spellRanks.length) s.push(["spells", "Spells"]);
    return s;
}

export function renderSection(host, LV, section) {
    const L = LV.ctx.level;
    switch (section) {
        case "overview": return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>What you gain</h2></div>
            <div class="meta">${gainChips(LV)}</div>
            <p class="lede">Your proficiency bonus rises by 1 for everything you're trained in. Hit Points go up by your class's ${LV.g.hp} plus your Constitution modifier. Work through the steps on the left, then level up.</p></div>`;
        case "features": return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>New class features</h2></div>
            <p class="lede">You get these automatically.</p>
            <div class="slots">${LV.features.map((f) => `<details class="slot" open><summary><b>${esc(f.name)}</b></summary><div class="rules">${host.descHTML(f.system?.description?.value)}</div></details>`).join("")}</div>
            ${host.choiceNodes(LV.choices.filter((n) => n.section === "features"), L)}</div>`;
        case "feats": return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>Feats</h2></div>
            ${LV.slots.map((s) => `<div class="sub-h">${SLOT_LABEL[s.key]} <span class="count ${s.value ? "ok" : "warn"}">${s.value ? 1 : 0} / 1</span></div><p class="note">${SLOT_HELP[s.key]}</p>
                ${host.picker(`lv${L}-${s.key}`, s.pool.map((f) => ({ value: f.uuid, name: f.name, rarity: f.system?.traits?.rarity, qual: LV.check(f), sub: `Level ${f.system?.level?.value ?? 1}` })), s.value, "feats", host.featDetail(LV.featDocs[s.key], LV.check), { lvl: L, slot: s.key })}`).join("")}
            ${host.choiceNodes(LV.choices.filter((n) => n.section === "feats"), L)}</div>`;
        case "skills": {
            const p = LV.plan;
            let html = `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>Skill increase</h2></div>`;
            if (LV.g.skillIncrease) {
                html += `<p class="lede">Raise one skill by one rank: untrained to trained, or trained to expert. At level ${L} the highest rank you can reach is ${RANK_NAME[LV.maxRank].toLowerCase()}.</p>
                <table class="stable"><tbody>${LV.skillOptions.map((o) => {
                    const on = p.skillInc === o.key;
                    const r = on ? o.rank + 1 : o.rank;
                    return `<tr><td><span class="prof ${RANK_LETTER[r]}">${RANK_LETTER[r]}</span></td><td><label class="toggle"><input type="radio" name="skillinc-${L}" data-lvl="${L}" data-lvskill="${esc(o.key)}" ${on ? "checked" : ""} ${o.ok ? "" : "disabled"}> ${esc(o.label)}</label> <span class="why">${o.attr.toUpperCase()} · ${RANK_NAME[o.rank]}${on ? ` → ${RANK_NAME[o.rank + 1]}` : ""}${o.ok ? "" : " · at max for this level"}</span></td></tr>`;
                }).join("")}</tbody></table>`;
            }
            if (LV.intUp) {
                const opts = LV.skillOptions?.filter((o) => !o.lore && o.rank === 0) ?? [];
                html += `<div class="sub-h">Extra trained skill (Intelligence increase)</div><div class="chips">${opts.map((o) => `<button type="button" class="chip ${(p.intSkills ?? []).includes(o.key) ? "on" : ""}" data-lvl="${L}" data-lvint="${esc(o.key)}">${esc(o.label)}</button>`).join("")}</div>
                <p class="note">You also learn a new language; add it on the sheet.</p>`;
            }
            return html + "</div>";
        }
        case "boosts": {
            const b = LV.plan.boosts ?? [];
            return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>Attribute boosts</h2><span class="count ${b.length === 4 ? "ok" : "warn"}">${b.length} / 4</span></div>
                <p class="lede">Boost four different attributes. A boost to an attribute that's already +4 or higher is a partial boost: it takes two partial boosts (at different levels) to raise it by 1.</p>
                <div class="attrs-pick">${ATTRS.map((a) => { const cur = LV.ctx.mods[a] ?? 0; const on = b.includes(a); const nxt = on ? (cur >= 4 ? `${cur >= 0 ? "+" : ""}${cur} (partial)` : `+${cur + 1}`) : `${cur >= 0 ? "+" : ""}${cur}`; return `<button type="button" class="ab ${on ? "on" : ""}" data-lvl="${L}" data-lvboost="${a}" ${!on && b.length >= 4 ? "disabled" : ""}><b>${esc(nxt)}</b><span>${ATTR_LABEL[a]}</span></button>`; }).join("")}</div></div>`;
        }
        case "spells": return `<div class="panel"><div class="panel-head"><span class="eyebrow">Level ${L}</span><h2>New spells</h2>${LV.ctx.tradition ? `<span class="tag acc">${esc(LV.ctx.tradition)}</span>` : ""}</div>
            <p class="lede">Each new spell slot adds a spell of that rank to your repertoire. Click a spell name to open it.</p>
            ${LV.spellRanks.map((r) => `<div class="sub-h">${ORD[r.rank]}-rank spells <span class="count ${r.chosen.length === r.pick ? "ok" : "warn"}">${r.chosen.length} / ${r.pick}</span><span class="note" style="text-transform:none;letter-spacing:0">${r.total} slots per day</span></div>
                ${r.granted ? `<div class="okbox">${esc(r.granted.name)} is added automatically from ${esc(LV.ctx.subDoc?.name ?? "your subclass")}.</div>` : ""}
                <div class="scrollbox" data-scroll="lvsp-${L}-${r.rank}"><table class="stable"><tbody>${r.pool.map((s) => { const on = r.chosen.includes(s.uuid); return `<tr><td><input type="checkbox" data-lvl="${L}" data-lvspell="${r.rank}" data-v="${esc(s.uuid)}" ${on ? "checked" : ""} ${!on && r.chosen.length >= r.pick ? "disabled" : ""}></td><td><a data-open="${esc(s.uuid)}">${esc(s.name)}</a> ${rarityTag(s.system?.traits?.rarity)} <span class="why">${esc((s.system?.traits?.value ?? []).join(", "))}</span></td></tr>`; }).join("") || '<tr><td></td><td class="note">No spells of this rank found for your tradition.</td></tr>'}</tbody></table></div>`).join("")}</div>`;
    }
    return "";
}

/** Routes level-plan events. `getPlan(L)` returns the mutable plan. Returns true if handled. */
export function handleLevelEvent(ev, getPlan, commit) {
    const t = ev.target.closest("[data-lvl]");
    if (!t) return false;
    const L = Number(t.dataset.lvl);
    const d = t.dataset;
    const plan = getPlan(L) ?? blankPlan();
    if (ev.type === "click" && t.tagName === "BUTTON") {
        if (d.lvpick) { plan.feats[d.lvslot] = plan.feats[d.lvslot] === d.v ? "" : d.v; commit(); return true; }
        if (d.lvboost) { const b = plan.boosts ?? []; plan.boosts = b.includes(d.lvboost) ? b.filter((x) => x !== d.lvboost) : b.length < 4 ? [...b, d.lvboost] : b; if (!plan.boosts.includes("int")) plan.intSkills = []; commit(); return true; }
        if (d.lvint) { plan.intSkills = (plan.intSkills ?? []).includes(d.lvint) ? [] : [d.lvint]; commit(); return true; }
        return false;
    }
    if (ev.type === "change") {
        if (d.lvskill) { plan.skillInc = d.lvskill; commit(); return true; }
        if (d.lvspell) { const r = Number(d.lvspell); const a = plan.spells[r] ?? []; plan.spells[r] = t.checked ? [...new Set([...a, d.v])] : a.filter((x) => x !== d.v); commit(); return true; }
        if (d.lvanswer) { if (t.value === "") delete plan.answers[d.lvanswer]; else plan.answers[d.lvanswer] = JSON.parse(t.value); commit(); return true; }
    }
    return false;
}
