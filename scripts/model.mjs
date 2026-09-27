import { CUSTOM, blankCustom, customAncestryDoc, mixedHeritageDoc, customBackgroundDoc, ancestryIssues, backgroundIssues, homebrewAllowed } from "./custom.mjs";
import { ATTRS, ATTR_LABEL, buildChoiceTree, grantedSpells, priceCredits, bulkValue, skillsFromRules, traditionFromRules, sluggify } from "./data.mjs";

export const STARTING_CREDITS = 150;

export function blankState() {
    return {
        v: 1,
        level: 1, levels: {}, startCredits: 150,
        name: "", player: "", gender: "", age: "", notes: "",
        anc: "", her: "", alt: false, ancSel: {}, altBoosts: [],
        bg: "", bgSel: {},
        cls: "", key: "",
        free: [],
        answers: {},
        skills: [], lores: [], langs: [],
        feats: { anc: "", cls: "" }, extra: [],
        custom: blankCustom(),
        spells: { cantrips: [], first: [] },
        gear: { armor: "", shield: "", weapons: [], items: [] },
    };
}

/**
 * Derive everything the UI and the creation step need from the wizard state.
 * Async because it walks ChoiceSets and loads granted items from compendiums.
 */
export async function derive(data, S) {
    const D = { issues: [], lvl: 1 };
    S.custom = foundry.utils.mergeObject(blankCustom(), S.custom ?? {});
    const anc = S.anc === CUSTOM.ancestry ? customAncestryDoc(data, S.custom.ancestry) : (data.ancestries.find((d) => d.uuid === S.anc) ?? null);
    const her = S.her === CUSTOM.heritage ? mixedHeritageDoc(data, S.custom.mixed, anc) : (data.heritages.find((d) => d.uuid === S.her) ?? null);
    const bg = S.bg === CUSTOM.background ? customBackgroundDoc(data, S.custom.background) : (data.backgrounds.find((d) => d.uuid === S.bg) ?? null);
    const cls = data.classes.find((d) => d.uuid === S.cls) ?? null;
    Object.assign(D, { anc, her, bg, cls });

    /* ---- class features gained at level 1 ---- */
    const features = [];
    if (cls) {
        for (const entry of Object.values(cls.system.items ?? {})) {
            if ((entry.level ?? 1) > 1 || !entry.uuid) continue;
            const f = await data.doc(entry.uuid);
            if (f) features.push(f);
        }
    }
    D.features = features;

    const featAnc = S.feats.anc ? await data.doc(S.feats.anc) : null;
    const featCls = S.feats.cls ? await data.doc(S.feats.cls) : null;
    const extra = (await Promise.all(S.extra.map((u) => data.doc(u)))).filter(Boolean);
    D.featAnc = featAnc; D.featCls = featCls; D.extraFeats = extra;

    /* ---- the choice tree (ChoiceSets the system would otherwise prompt for) ---- */
    const roots = [];
    if (anc) roots.push({ doc: anc, section: "ancestry" });
    if (her) roots.push({ doc: her, section: "ancestry" });
    if (bg) roots.push({ doc: bg, section: "background" });
    if (cls) roots.push({ doc: cls, section: "class" });
    for (const f of features) roots.push({ doc: f, section: "class" });
    if (featAnc) roots.push({ doc: featAnc, section: "feats" });
    if (featCls) roots.push({ doc: featCls, section: "feats" });
    for (const f of extra) roots.push({ doc: f, section: "feats" });
    // Items granted by the background (its skill feat)
    if (bg) for (const e of Object.values(bg.system.items ?? {})) { const f = await data.doc(e.uuid); if (f) roots.push({ doc: f, section: "background" }); }
    const tree = await buildChoiceTree(data, roots, S.answers);
    D.choices = tree.nodes;
    D.visited = tree.visited;
    D.unanswered = tree.nodes.filter((n) => n.answer === null);

    /* ---- attributes ---- */
    const boosts = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const flaws = Object.fromEntries(ATTRS.map((a) => [a, 0]));
    const rows = [];
    if (anc) {
        if (S.alt) {
            rows.push(["ancestry", S.altBoosts.slice(0, 2)]);
        } else {
            const list = [];
            for (const [k, b] of Object.entries(anc.system.boosts ?? {})) {
                const v = b.value ?? [];
                if (v.length === 1) list.push(v[0]);
                else if (v.length > 1 && S.ancSel[k]) list.push(S.ancSel[k]);
            }
            rows.push(["ancestry", list]);
            for (const f of Object.values(anc.system.flaws ?? {})) if ((f.value ?? []).length === 1) flaws[f.value[0]]++;
        }
    }
    if (bg) rows.push(["background", Object.entries(bg.system.boosts ?? {}).map(([k, b]) => ((b.value ?? []).length === 1 ? b.value[0] : S.bgSel[k])).filter(Boolean)]);
    D.keyOptions = cls ? (cls.system.keyAbility?.value ?? []) : [];
    D.key = D.keyOptions.length === 1 ? D.keyOptions[0] : (D.keyOptions.includes(S.key) ? S.key : "");
    if (D.key) rows.push(["class", [D.key]]);
    rows.push(["free", S.free.slice(0, 4)]);
    for (const [, list] of rows) for (const a of list) if (a in boosts) boosts[a]++;
    D.mod = Object.fromEntries(ATTRS.map((a) => [a, boosts[a] - flaws[a]]));

    /* ---- HP ---- */
    let ancHP = anc?.system.hp ?? 0;
    for (const r of her?.system.rules ?? []) if (r.key === "ActiveEffectLike" && r.path === "system.attributes.ancestryhp") ancHP = Number(r.value) || ancHP;
    D.hp = anc && cls ? ancHP + (cls.system.hp ?? 0) + D.mod.con : null;

    /* ---- skills ---- */
    const auto = {};
    const add = (s, why) => { (auto[s] ??= []).push(why); };
    for (const s of bg?.system.trainedSkills?.value ?? []) add(s, "Background");
    for (const s of cls?.system.trainedSkills?.value ?? []) add(s, "Class");
    for (const { skill, source } of skillsFromRules(tree.visited)) add(skill, source);
    D.autoSkills = auto;
    const dupes = Object.values(auto).reduce((n, r) => n + Math.max(0, new Set(r).size - 1), 0);
    D.skillPicks = cls ? Math.max(0, (cls.system.trainedSkills?.additional ?? 0) + D.mod.int) + dupes : 0;
    D.chosenSkills = S.skills.filter((s) => !auto[s]);
    D.trained = new Set([...Object.keys(auto), ...D.chosenSkills]);
    D.lores = [...new Set([...(bg?.system.trainedSkills?.lore ?? []), ...S.lores.map((l) => (/lore$/i.test(l) ? l : `${l} Lore`))])];
    const left = D.skillPicks - D.chosenSkills.length;
    if (cls && left > 0) D.issues.push(["skills", `${left} skill pick${left > 1 ? "s" : ""} left to spend.`]);
    if (cls && left < 0) D.issues.push(["skills", `${-left} more skill${left < -1 ? "s" : ""} than you have picks for.`]);

    /* ---- languages ---- */
    D.langBase = anc?.system.languages?.value ?? [];
    D.langPicks = anc ? (anc.system.additionalLanguages?.count ?? 0) + Math.max(0, D.mod.int) : 0;
    const extraL = S.langs.filter((l) => !D.langBase.includes(l));
    if (anc && extraL.length < D.langPicks) D.issues.push(["skills", `${D.langPicks - extraL.length} language${D.langPicks - extraL.length > 1 ? "s" : ""} left to choose.`]);

    /* ---- spells ---- */
    D.caster = !!cls && (cls.system.spellcasting ?? 0) > 0;
    if (D.caster) {
        D.tradition = traditionFromRules(tree.visited);
        const sub = tree.visited.find((v) => (v.doc.system?.rules ?? []).some((r) => r.key === "ActiveEffectLike" && /\.tradition$/.test(r.path ?? "")));
        D.subDoc = sub?.doc ?? null;
        const g = grantedSpells(D.subDoc);
        D.grantedCantrip = g.cantrip ? await data.doc(g.cantrip) : null;
        D.grantedFirst = g.first ? await data.doc(g.first) : null;
        D.focusSpell = g.focus ? await data.doc(g.focus) : null;
        if (!D.tradition) D.issues.push(["spells", "Choose your connection or paradox on the Class step to set your spell tradition."]);
        else {
            if (S.spells.cantrips.length < 4) D.issues.push(["spells", `${4 - S.spells.cantrips.length} cantrip${4 - S.spells.cantrips.length === 1 ? "" : "s"} left to learn.`]);
            if (S.spells.first.length < 2) D.issues.push(["spells", `${2 - S.spells.first.length} 1st-rank spell${2 - S.spells.first.length === 1 ? "" : "s"} left to learn.`]);
        }
    }

    /* ---- gear ---- */
    let spent = 0, bulk = 0;
    const line = (uuid, q = 1) => { const e = data.entry(uuid); if (!e) return; spent += priceCredits(e.system?.price) * q; bulk += bulkValue(e.system?.bulk) * q; };
    if (S.gear.armor) line(S.gear.armor);
    if (S.gear.shield) line(S.gear.shield);
    for (const w of S.gear.weapons) line(w.uuid, w.q);
    for (const i of S.gear.items) line(i.uuid, i.q);
    D.spent = Math.round(spent * 10) / 10;
    D.startCredits = Number.isFinite(Number(S.startCredits)) ? Number(S.startCredits) : STARTING_CREDITS;
    D.credits = Math.round((D.startCredits - spent) * 10) / 10;
    D.bulk = Math.round(bulk * 10) / 10;
    D.bulkLimit = 5 + D.mod.str;
    if (D.credits < 0) D.issues.push(["gear", `Over budget by ${-D.credits} credits.`]);

    /* ---- core validation ---- */
    if (S.anc === CUSTOM.ancestry) for (const i of ancestryIssues(S.custom.ancestry)) D.issues.push(["ancestry", i]);
    if (S.her === CUSTOM.heritage && !S.custom.mixed.second) D.issues.push(["ancestry", "Custom mixed heritage: choose the second ancestry."]);
    if (S.bg === CUSTOM.background) for (const i of backgroundIssues(S.custom.background)) D.issues.push(["background", i]);
    D.homebrew = S.anc === CUSTOM.ancestry || S.bg === CUSTOM.background;
    if (D.homebrew && !homebrewAllowed()) D.issues.push(["ancestry", "Your GM has turned off homebrew. Choose an official ancestry and background."]);
    if (!anc) D.issues.unshift(["ancestry", "Choose an ancestry."]);
    else if (!her) D.issues.unshift(["ancestry", "Choose a heritage."]);
    if (!bg) D.issues.unshift(["background", "Choose a background."]);
    if (!cls) D.issues.unshift(["class", "Choose a class."]);
    if (cls && D.keyOptions.length > 1 && !D.key) D.issues.push(["class", "Choose your key attribute."]);
    if (anc && !S.feats.anc) D.issues.push(["feats", "Choose an ancestry feat."]);
    D.hasClassFeat = !!cls && (cls.system.classFeatLevels?.value ?? []).includes(1);
    if (D.hasClassFeat && !S.feats.cls) D.issues.push(["feats", "Choose a class feat."]);
    const needAnc = anc ? (S.alt ? 2 : Object.values(anc.system.boosts ?? {}).filter((b) => (b.value ?? []).length > 1).length) : 0;
    const haveAnc = anc ? (S.alt ? S.altBoosts.length : Object.entries(anc.system.boosts ?? {}).filter(([k, b]) => (b.value ?? []).length > 1 && S.ancSel[k]).length) : 0;
    const needBg = bg ? Object.values(bg.system.boosts ?? {}).filter((b) => (b.value ?? []).length > 1).length : 0;
    const haveBg = bg ? Object.entries(bg.system.boosts ?? {}).filter(([k, b]) => (b.value ?? []).length > 1 && S.bgSel[k]).length : 0;
    const missing = [];
    if (haveAnc < needAnc) missing.push("ancestry");
    if (haveBg < needBg) missing.push("background");
    if (S.free.length < 4) missing.push("four free boosts");
    if (missing.length) D.issues.push(["attributes", `Attribute boosts still to place: ${missing.join(", ")}.`]);
    for (const n of D.unanswered) {
        D.issues.push([n.section === "ancestry" ? "ancestry" : n.section === "background" ? "background" : n.section === "class" ? "class" : "feats",
            n.options ? `${n.itemName}: ${n.prompt}` : `${n.itemName}: you'll be asked while the character is built.`, n.options ? "warn" : "info"]);
    }
    D.attrLabel = ATTR_LABEL;
    return D;
}

export { sluggify };
