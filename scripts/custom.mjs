/**
 * Custom options built inside the Forge.
 *  - Custom mixed heritage: official rule (Player Core pg. 83, Galactic Ancestries pg. 5), needs GM approval.
 *  - Custom background and custom ancestry: homebrew, modeled on the shape of every official one.
 * Each builder returns a pseudo-document shaped like a compendium item, plus toSource() for actor creation.
 */
import { ATTRS, ATTR_LABEL, sluggify } from "./data.mjs";

export const MODULE_ID = "sf2e-character-forge";
export const CUSTOM = { ancestry: "__custom-ancestry", heritage: "__mixed-heritage", background: "__custom-background" };
export const CREATURE_TYPES = ["aberration", "animal", "beast", "construct", "dragon", "elemental", "fey", "fungus", "humanoid", "ooze", "plant", "undead"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function blankCustom() {
    return {
        mixed: { second: "", name: "" },
        background: { name: "", desc: "", boostA: "", boostB: "", skill: "", lore: "", feat: "" },
        ancestry: { name: "", desc: "", hp: 8, size: "med", speed: 25, pattern: "two", b1: "", b2: "", flaw: "", vision: "normal", type: "humanoid", lang: "", extraLangs: 0, featFrom: "" },
    };
}

export function homebrewAllowed() {
    try { return !!game.settings.get(MODULE_ID, "allowHomebrew"); } catch (e) { return true; }
}

function pseudo(uuid, type, name, img, system) {
    const flags = { [MODULE_ID]: { custom: type, homebrew: uuid !== CUSTOM.heritage } };
    return {
        uuid, id: uuid, type, name, img, system, flags, custom: true,
        toSource() { return { name, type, img, system: foundry.utils.deepClone(system), flags: foundry.utils.deepClone(flags) }; },
    };
}

/* ---------------- Custom mixed heritage (official) ---------------- */
export function mixedHeritageDoc(data, spec, mainAnc) {
    const second = data.ancestries.find((a) => a.uuid === spec.second) ?? null;
    if (!mainAnc) return null;
    const secondSlug = second?.system?.slug ?? (second ? sluggify(second.name) : null);
    const name = spec.name?.trim() || (second ? `Mixed ${mainAnc.name} (${second.name})` : `Mixed ${mainAnc.name}`);
    const lowLight = ["low-light-vision", "darkvision"].includes(second?.system?.vision);
    const rules = [];
    if (secondSlug) rules.push({ key: "ActorTraits", add: [secondSlug] });
    if (lowLight) rules.push({ key: "Sense", selector: "low-light-vision" });
    const desc = `<p><strong>Custom mixed heritage</strong> (Player Core pg. 83; uncommon, with your GM's approval).</p>
        <p>You have both ${esc(mainAnc.name)} and ${second ? esc(second.name) : "another ancestry's"} ancestry. You gain the ${second ? esc(second.name.toLowerCase()) : "chosen ancestry's"} trait${lowLight ? " and low-light vision" : ""}, and you can select ancestry feats for ${second ? esc(second.name) : "that ancestry"} in addition to those from your base ancestry.</p>`;
    return {
        ...pseudo(CUSTOM.heritage, "heritage", name, second?.img ?? mainAnc.img ?? "icons/svg/aura.svg", {
            slug: sluggify(name),
            ancestry: { name: mainAnc.name, slug: mainAnc.system.slug ?? sluggify(mainAnc.name), uuid: mainAnc.custom ? null : mainAnc.uuid },
            traits: { value: secondSlug ? [secondSlug] : [], rarity: "uncommon" },
            rules,
            description: { value: desc },
            publication: { title: "Player Core (custom mixed heritage)", license: "ORC", remaster: true },
        }),
        second,
    };
}

/* ---------------- Custom background (homebrew) ---------------- */
export function customBackgroundDoc(data, spec) {
    const name = spec.name?.trim() || "Custom Background";
    const feat = spec.feat ? data.entry(spec.feat) : null;
    const boostA = [spec.boostA, spec.boostB].filter(Boolean);
    const lore = spec.lore?.trim() ? (/lore$/i.test(spec.lore.trim()) ? spec.lore.trim() : `${spec.lore.trim()} Lore`) : "";
    const skillLabel = data.skills.find((s) => s.slug === spec.skill)?.label ?? spec.skill;
    const desc = `${spec.desc ? `<p>${esc(spec.desc)}</p>` : ""}<p>Choose two attribute boosts. One must be to ${boostA.map((a) => ATTR_LABEL[a]).join(" or ") || "(pick two)"}, and one is a free attribute boost.</p>
        <p>You're trained in ${skillLabel ? esc(skillLabel) : "(a skill)"}${lore ? ` and ${esc(lore)}` : ""}. You gain the ${feat ? esc(feat.name) : "(a skill feat)"} skill feat.</p><p><em>Homebrew background made in the Character Forge.</em></p>`;
    return pseudo(CUSTOM.background, "background", name, "icons/svg/book.svg", {
        slug: sluggify(name),
        boosts: { 0: { value: boostA.length === 2 ? boostA : [...ATTRS], selected: null }, 1: { value: [...ATTRS], selected: null } },
        trainedSkills: { value: spec.skill ? [spec.skill] : [], lore: lore ? [lore] : [] },
        items: feat ? { forgeFeat: { uuid: feat.uuid, name: feat.name, img: feat.img, level: 1 } } : {},
        traits: { value: ["homebrew"], rarity: "common" },
        rules: [],
        description: { value: desc },
        publication: { title: "Homebrew", license: "", remaster: true },
    });
}

export function backgroundIssues(spec) {
    const out = [];
    if (!spec.name?.trim()) out.push("Name your custom background.");
    if (!spec.boostA || !spec.boostB || spec.boostA === spec.boostB) out.push("Custom background: pick two different attributes for its first boost.");
    if (!spec.skill) out.push("Custom background: pick its trained skill.");
    if (!spec.lore?.trim()) out.push("Custom background: name its Lore skill.");
    if (!spec.feat) out.push("Custom background: pick its skill feat.");
    return out;
}

/* ---------------- Custom ancestry (homebrew) ---------------- */
export function customAncestryDoc(data, spec) {
    const name = spec.name?.trim() || "Custom Ancestry";
    const from = spec.featFrom ? data.ancestries.find((a) => a.uuid === spec.featFrom) : null;
    const fromSlug = from ? (from.system.slug ?? sluggify(from.name)) : null;
    const boosts = {}, flaws = {};
    if (spec.pattern === "free") { boosts[0] = { value: [...ATTRS], selected: null }; boosts[1] = { value: [...ATTRS], selected: null }; }
    else if (spec.pattern === "one") { boosts[0] = { value: spec.b1 ? [spec.b1] : [...ATTRS], selected: null }; boosts[1] = { value: [...ATTRS], selected: null }; }
    else {
        boosts[0] = { value: spec.b1 ? [spec.b1] : [...ATTRS], selected: null };
        boosts[1] = { value: spec.b2 ? [spec.b2] : [...ATTRS], selected: null };
        boosts[2] = { value: [...ATTRS], selected: null };
        if (spec.flaw) flaws[0] = { value: [spec.flaw], selected: null };
    }
    const langs = ["common", ...(spec.lang && spec.lang !== "common" ? [spec.lang] : [])];
    const traits = [spec.type || "humanoid", ...(fromSlug ? [fromSlug] : [])];
    const desc = `${spec.desc ? `<p>${esc(spec.desc)}</p>` : ""}<p><em>Homebrew ancestry made in the Character Forge.${from ? ` It uses ${esc(from.name)} heritages and ancestry feats.` : ""}</em></p>`;
    const doc = pseudo(CUSTOM.ancestry, "ancestry", name, "icons/svg/mystery-man.svg", {
        slug: sluggify(name),
        hp: Number(spec.hp) || 8, size: spec.size || "med", speed: Number(spec.speed) || 25,
        boosts, flaws,
        languages: { value: langs, custom: "" },
        additionalLanguages: { count: Number(spec.extraLangs) || 0, value: [], custom: "" },
        vision: spec.vision || "normal", hands: 2, reach: 5,
        traits: { value: traits, rarity: "uncommon" },
        items: {}, rules: [],
        description: { value: desc },
        publication: { title: "Homebrew", license: "", remaster: true },
    });
    doc.system.forgeFeatFrom = fromSlug;
    doc.featFrom = from;
    return doc;
}

export function ancestryIssues(spec) {
    const out = [];
    if (!spec.name?.trim()) out.push("Name your custom ancestry.");
    if (spec.pattern === "two") {
        if (!spec.b1 || !spec.b2 || spec.b1 === spec.b2) out.push("Custom ancestry: pick two different fixed boosts.");
        if (!spec.flaw) out.push("Custom ancestry: pick its flaw.");
        else if ([spec.b1, spec.b2].includes(spec.flaw)) out.push("Custom ancestry: the flaw can't be one of its boosts.");
    }
    if (spec.pattern === "one" && !spec.b1) out.push("Custom ancestry: pick its fixed boost.");
    return out;
}

/* ---------------- Forms ---------------- */
const chips = (path, cur, opts) => `<div class="chips">${opts.map(([v, l]) => `<button type="button" class="chip ${String(cur) === String(v) ? "on" : ""}" data-custset="${path}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
const attrSel = (path, cur, label, exclude = []) => `<select data-cust="${path}" aria-label="${esc(label)}"><option value="">—</option>${ATTRS.map((a) => `<option value="${a}" ${cur === a ? "selected" : ""} ${exclude.includes(a) && cur !== a ? "disabled" : ""}>${ATTR_LABEL[a]}</option>`).join("")}</select>`;
const field = (label, html, hint = "") => `<div class="field"><label>${label}</label>${html}${hint ? `<span class="note">${hint}</span>` : ""}</div>`;
const text = (path, v, ph = "") => `<input type="text" data-cust="${path}" value="${esc(v)}" placeholder="${esc(ph)}">`;

export function mixedForm(data, spec, mainAnc) {
    const opts = data.ancestries.filter((a) => a.uuid !== mainAnc?.uuid).map((a) => `<option value="${esc(a.uuid)}" ${a.uuid === spec.second ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    const second = data.ancestries.find((a) => a.uuid === spec.second);
    return `<div class="cust-form"><div class="eyebrow">Official rule · needs GM approval</div><h3>Custom mixed heritage</h3>
        <p class="note">Player Core pg. 83: an uncommon heritage for a character with two ancestral lines. You gain the second ancestry's trait, low-light vision if it has low-light vision or darkvision, and access to its ancestry feats alongside your own.</p>
        <div class="grid2">${field("Second ancestry", `<select data-cust="mixed.second"><option value="">— choose —</option>${opts}</select>`)}
        ${field("Heritage name", text("mixed.name", spec.name, second && mainAnc ? `Mixed ${mainAnc.name} (${second.name})` : "e.g. Half-vesk"), "What you call your people.")}</div>
        ${second ? `<div class="okbox">Adds the <b>${esc(second.name.toLowerCase())}</b> trait${["low-light-vision", "darkvision"].includes(second.system.vision) ? " and <b>low-light vision</b>" : ""}, and ${esc(second.name)} ancestry feats appear in your feat lists.</div>` : ""}</div>`;
}

export function backgroundForm(data, spec) {
    const skillOpts = data.skills.map((s) => `<option value="${s.slug}" ${spec.skill === s.slug ? "selected" : ""}>${esc(s.label)}</option>`).join("");
    const skillFeats = data.feats.filter((f) => (f.system?.category === "skill" || (f.system?.traits?.value ?? []).includes("skill")) && (f.system?.level?.value ?? 1) === 1);
    const skillLabel = data.skills.find((s) => s.slug === spec.skill)?.label ?? "";
    const match = spec.skill ? skillFeats.filter((f) => JSON.stringify(f.system?.prerequisites ?? "").toLowerCase().includes(skillLabel.toLowerCase())) : [];
    const rest = skillFeats.filter((f) => !match.includes(f));
    const optList = (list) => list.map((f) => `<option value="${esc(f.uuid)}" ${spec.feat === f.uuid ? "selected" : ""}>${esc(f.name)}</option>`).join("");
    return `<div class="cust-form"><div class="eyebrow">Homebrew</div><h3>Custom background</h3>
        <p class="note">Built the same way as every official background: two attribute boosts (one from a choice of two, one free), one trained skill, one Lore skill and one 1st-level skill feat.</p>
        <div class="grid2">${field("Name", text("background.name", spec.name, "e.g. Asteroid Miner"))}
        ${field("Trained skill", `<select data-cust="background.skill"><option value="">— choose —</option>${skillOpts}</select>`)}</div>
        ${field("Description", `<textarea data-cust="background.desc" placeholder="Who were you before you started adventuring?">${esc(spec.desc)}</textarea>`)}
        <div class="grid2">${field("First boost: one of", `<div class="inline" style="margin:0">${attrSel("background.boostA", spec.boostA, "First option", [spec.boostB])}<span>or</span>${attrSel("background.boostB", spec.boostB, "Second option", [spec.boostA])}</div>`, "The second boost is always free.")}
        ${field("Lore skill", text("background.lore", spec.lore, "e.g. Mining"), "A narrow Lore tied to the background.")}</div>
        ${field("Skill feat", `<select data-cust="background.feat"><option value="">— choose —</option>${match.length ? `<optgroup label="${esc(skillLabel)} feats">${optList(match)}</optgroup>` : ""}<optgroup label="${match.length ? "Other skill feats" : "Skill feats"}">${optList(rest)}</optgroup></select>`, "Pick one tied to the trained skill if you can.")}</div>`;
}

export function ancestryForm(data, spec) {
    const langOpts = data.languages.filter((l) => l.slug !== "common").map((l) => `<option value="${l.slug}" ${spec.lang === l.slug ? "selected" : ""}>${esc(l.label)}</option>`).join("");
    const fromOpts = data.ancestries.map((a) => `<option value="${esc(a.uuid)}" ${spec.featFrom === a.uuid ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    let boosts = "";
    if (spec.pattern === "two") boosts = `<div class="grid2">${field("Fixed boost 1", attrSel("ancestry.b1", spec.b1, "Boost 1", [spec.b2, spec.flaw]))}${field("Fixed boost 2", attrSel("ancestry.b2", spec.b2, "Boost 2", [spec.b1, spec.flaw]))}${field("Flaw", attrSel("ancestry.flaw", spec.flaw, "Flaw", [spec.b1, spec.b2]))}</div>`;
    else if (spec.pattern === "one") boosts = `<div class="grid2">${field("Fixed boost", attrSel("ancestry.b1", spec.b1, "Boost"))}</div>`;
    return `<div class="cust-form"><div class="eyebrow">Homebrew</div><h3>Custom ancestry</h3>
        <p class="note">Every choice here is limited to what official Starfinder ancestries use, so the result stays balanced. It's still homebrew: check with your GM.</p>
        <div class="grid2">${field("Name", text("ancestry.name", spec.name, "e.g. Quorlu"))}${field("Creature type", `<select data-cust="ancestry.type">${CREATURE_TYPES.map((t) => `<option value="${t}" ${spec.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>`)}</div>
        ${field("Description", `<textarea data-cust="ancestry.desc" placeholder="What are your people like?">${esc(spec.desc)}</textarea>`)}
        <div class="grid2">${field("Hit Points", chips("ancestry.hp", spec.hp, [[6, "6"], [8, "8"], [10, "10"]]), "Frail 6, typical 8, hardy 10.")}
        ${field("Size", chips("ancestry.size", spec.size, [["sm", "Small"], ["med", "Medium"], ["lg", "Large"]]))}
        ${field("Speed", chips("ancestry.speed", spec.speed, [[20, "20 ft"], [25, "25 ft"], [30, "30 ft"]]))}
        ${field("Vision", chips("ancestry.vision", spec.vision, [["normal", "Normal"], ["low-light-vision", "Low-light"], ["darkvision", "Darkvision"]]))}</div>
        ${field("Attribute boosts", chips("ancestry.pattern", spec.pattern, [["two", "Two boosts + free, one flaw"], ["one", "One boost + free"], ["free", "Two free boosts"]]), "The same three patterns official ancestries use.")}
        ${boosts}
        <div class="grid2">${field("Ancestry language", `<select data-cust="ancestry.lang"><option value="">Common only</option>${langOpts}</select>`, "You always know Common.")}
        ${field("Extra languages", chips("ancestry.extraLangs", spec.extraLangs, [[0, "Int only"], [1, "1 + Int"]]))}</div>
        ${field("Heritages and ancestry feats from", `<select data-cust="ancestry.featFrom"><option value="">None: versatile heritages and standardized feats only</option>${fromOpts}</select>`, "Pick the closest official ancestry to borrow its heritages and feat list.")}</div>`;
}

/** Set a nested custom field from a data-cust path like "ancestry.hp" */
export function setCustom(custom, path, value) {
    const [group, key] = path.split(".");
    custom[group] ??= {};
    custom[group][key] = ["hp", "speed", "extraLangs"].includes(key) ? Number(value) : value;
    if (group === "ancestry" && key === "pattern") { custom.ancestry.b1 = ""; custom.ancestry.b2 = ""; custom.ancestry.flaw = ""; }
}
