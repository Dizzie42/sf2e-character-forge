/**
 * Level-up rules and the engine that applies a level to an actor.
 * Used by the Level Up window (existing characters) and by the creator (starting above 1st level).
 */
import { ATTRS, buildChoiceTree, localize, sluggify } from "./data.mjs";
import { FORGE_RUN } from "./create.mjs";
import { qualifier, creatorNames } from "./prereq.mjs";

export const MODULE_ID = "sf2e-character-forge";
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
export const RANK_LETTER = ["U", "T", "E", "M", "L"];
export const RANK_NAME = ["Untrained", "Trained", "Expert", "Master", "Legendary"];

export function blankPlan() {
    return { feats: { class: "", skill: "", general: "", ancestry: "" }, skillInc: "", boosts: [], intSkills: [], spells: {}, answers: {} };
}

/** Spontaneous caster slots (mystic, witchwarper) */
export function slots(level, rank) {
    if (rank === 10) return level >= 19 ? 1 : 0;
    if (level < rank * 2 - 1) return 0;
    return level === rank * 2 - 1 ? 3 : 4;
}
export function maxSkillRank(level) { return level >= 15 ? 4 : level >= 7 ? 3 : 2; }

/** What a class gains at a given level */
export function gainsAt(cls, level) {
    const has = (k) => (cls?.system?.[k]?.value ?? []).includes(level);
    const g = {
        level,
        classFeat: has("classFeatLevels"),
        skillFeat: has("skillFeatLevels"),
        generalFeat: has("generalFeatLevels"),
        ancestryFeat: has("ancestryFeatLevels"),
        skillIncrease: has("skillIncreaseLevels"),
        boosts: level % 5 === 0,
        features: Object.values(cls?.system?.items ?? {}).filter((e) => e.level === level && e.uuid),
        hp: cls?.system?.hp ?? 0,
        spells: {},
    };
    if ((cls?.system?.spellcasting ?? 0) > 0) {
        for (let r = 1; r <= 10; r++) {
            const add = slots(level, r) - slots(level - 1, r);
            if (add > 0) g.spells[r] = { add, opened: slots(level - 1, r) === 0 };
        }
    }
    return g;
}

export function featSlotKeys(g) {
    return [["class", g.classFeat], ["skill", g.skillFeat], ["general", g.generalFeat], ["ancestry", g.ancestryFeat]].filter(([, on]) => on).map(([k]) => k);
}

export function grantedSpellAtRank(subDoc, rank) {
    const html = subDoc?.system?.description?.value ?? "";
    const m = new RegExp(`${ORD[rank]}:\\s*@UUID\\[([^\\]]+)\\]`, "i").exec(html);
    return m ? m[1] : null;
}

/* ------------------------------------------------------------------------------------------------
 * Context: the character as it stands before gaining `level`.
 * ---------------------------------------------------------------------------------------------- */

/** From an existing actor */
export async function ctxFromActor(data, actor) {
    const level = (actor.level ?? actor.system.details.level.value) + 1;
    const clsItem = actor.class ?? actor.itemTypes?.class?.[0];
    const cls = data.classes.find((c) => (c.system.slug ?? sluggify(c.name)) === (clsItem?.slug ?? clsItem?.system?.slug)) ?? clsItem ?? null;
    const mods = Object.fromEntries(ATTRS.map((a) => [a, actor.system.abilities?.[a]?.mod ?? 0]));
    const ranks = Object.fromEntries(data.skills.map((s) => [s.slug, actor.system.skills?.[s.slug]?.rank ?? 0]));
    const lores = (actor.itemTypes?.lore ?? []).map((l) => ({ id: l.id, name: l.name, rank: l.system.proficient?.value ?? 0 }));
    const feats = actor.itemTypes?.feat ?? [];
    const ownedFeats = new Set(feats.map((f) => f.system.slug ?? sluggify(f.name)));
    const entry = (actor.itemTypes?.spellcastingEntry ?? []).find((e) => e.system.prepared?.value === "spontaneous") ?? null;
    const known = new Set((actor.itemTypes?.spell ?? []).filter((s) => entry && s.system.location?.value === entry.id).map((s) => s.sourceId ?? s.uuid));
    const knownNames = new Set((actor.itemTypes?.spell ?? []).map((s) => s.name));
    let subDoc = null;
    for (const f of feats) {
        if ((f.system.rules ?? []).some((r) => r.key === "ActiveEffectLike" && /\.tradition$/.test(r.path ?? ""))) { subDoc = f.sourceId ? (await data.doc(f.sourceId)) ?? f : f; break; }
    }
    return {
        level, cls, mods, ranks, lores, ownedFeats, known, knownNames,
        ancestry: actor.ancestry ?? actor.itemTypes?.ancestry?.[0] ?? null,
        heritage: actor.heritage ?? actor.itemTypes?.heritage?.[0] ?? null,
        caster: !!entry || (cls?.system?.spellcasting ?? 0) > 0,
        tradition: entry?.system?.tradition?.value ?? null,
        subDoc,
        key: actor.system.details?.keyability?.value ?? null,
        xp: actor.system.details?.xp ?? null,
        name: actor.name,
        names: (actor.items?.contents ?? actor.items ?? []).map((i) => i.name),
        vision: (actor.ancestry ?? actor.itemTypes?.ancestry?.[0])?.system?.vision ?? null,
    };
}

/** From the creator's state, for starting levels above 1 */
export function ctxFromCreator(data, S, D, level) {
    const ranks = Object.fromEntries(data.skills.map((s) => [s.slug, D.trained.has(s.slug) ? 1 : 0]));
    const lores = D.lores.map((n) => ({ id: null, name: n, rank: 1 }));
    const mods = { ...D.mod };
    const ownedFeats = new Set();
    const known = new Set([...S.spells.cantrips, ...S.spells.first, D.grantedCantrip?.uuid, D.grantedFirst?.uuid].filter(Boolean));
    for (const d of [D.featAnc, D.featCls, ...D.extraFeats]) if (d) ownedFeats.add(d.system.slug ?? sluggify(d.name));
    const names = creatorNames(D);
    for (let L = 2; L < level; L++) {
        const p = S.levels?.[L]; if (!p) continue;
        if (p.skillInc) { if (p.skillInc in ranks) ranks[p.skillInc]++; else { const l = lores.find((x) => x.name === p.skillInc); if (l) l.rank++; } }
        for (const s of p.intSkills ?? []) if (s in ranks) ranks[s] = Math.max(ranks[s], 1);
        for (const a of p.boosts ?? []) mods[a] = mods[a] >= 4 ? mods[a] : mods[a] + 1;
        for (const u of Object.values(p.feats ?? {})) { const e = data.entry(u); if (e) { ownedFeats.add(e.system?.slug ?? sluggify(e.name)); names.push(e.name); } }
        for (const list of Object.values(p.spells ?? {})) for (const u of list) known.add(u);
        const g = gainsAt(D.cls, L);
        for (const [r, info] of Object.entries(g.spells)) if (info.opened) { const u = grantedSpellAtRank(D.subDoc, Number(r)); if (u) known.add(u); }
    }
    return {
        level, cls: D.cls, mods, ranks, lores, ownedFeats, known, knownNames: new Set(),
        ancestry: D.anc, heritage: D.her, caster: D.caster, tradition: D.tradition, subDoc: D.subDoc, key: D.key, xp: null,
        name: S.name, names, vision: D.anc?.system?.vision ?? null,
    };
}

/* ------------------------------------------------------------------------------------------------
 * Everything the level UI needs for one level: gains, option pools, choices, issues.
 * ---------------------------------------------------------------------------------------------- */
export async function deriveLevel(data, ctx, plan, visible = () => true) {
    const L = ctx.level;
    const g = gainsAt(ctx.cls, L);
    const out = { g, ctx, plan, issues: [] };
    out.check = qualifier(data, { ranks: ctx.ranks, lores: ctx.lores, mods: ctx.mods, level: L, names: ctx.names ?? [], vision: ctx.vision });
    const lvlOk = (e) => (e.system?.level?.value ?? 0) <= L;
    const notOwned = (e, selected) => selected || (e.system?.maxTakable ?? 1) > 1 || !ctx.ownedFeats.has(e.system?.slug ?? sluggify(e.name));
    const traits = (e) => e.system?.traits?.value ?? [];
    const clsSlug = ctx.cls?.system?.slug ?? sluggify(ctx.cls?.name ?? "");
    const TYPES = new Set(["humanoid", "aberration", "animal", "beast", "construct", "dragon", "elemental", "fey", "fungus", "ooze", "plant", "undead", "homebrew"]);
    const ancTraits = new Set([ctx.ancestry?.system?.slug ?? ctx.ancestry?.slug, ...(ctx.ancestry?.system?.traits?.value ?? []), ...(ctx.heritage?.system?.traits?.value ?? [])].filter((t) => t && !TYPES.has(t)));
    const pools = {
        class: (sel) => data.feats.filter((f) => f.system?.category === "class" && lvlOk(f) && traits(f).includes(clsSlug) && visible(f, f.uuid === sel) && notOwned(f, f.uuid === sel)),
        skill: (sel) => data.feats.filter((f) => (f.system?.category === "skill" || traits(f).includes("skill")) && lvlOk(f) && visible(f, f.uuid === sel) && notOwned(f, f.uuid === sel)),
        general: (sel) => data.feats.filter((f) => traits(f).includes("general") && lvlOk(f) && visible(f, f.uuid === sel) && notOwned(f, f.uuid === sel)),
        ancestry: (sel) => data.feats.filter((f) => f.system?.category === "ancestry" && lvlOk(f) && (traits(f).some((t) => ancTraits.has(t)) || (traits(f).length === 1 && traits(f)[0] === "ancestry")) && visible(f, f.uuid === sel) && notOwned(f, f.uuid === sel)),
    };
    out.slots = featSlotKeys(g).map((k) => ({ key: k, pool: pools[k](plan.feats[k]), value: plan.feats[k] }));

    // documents we show in detail
    out.features = (await Promise.all(g.features.map((e) => data.doc(e.uuid)))).filter(Boolean);
    out.featDocs = {};
    for (const s of out.slots) if (s.value) out.featDocs[s.key] = await data.doc(s.value);

    // ChoiceSets on new class features and on chosen feats
    const roots = [...out.features.map((d) => ({ doc: d, section: "features" })), ...Object.values(out.featDocs).filter(Boolean).map((d) => ({ doc: d, section: "feats" }))];
    const tree = await buildChoiceTree(data, roots, plan.answers);
    out.choices = tree.nodes;

    // skills
    const maxR = maxSkillRank(L);
    out.maxRank = maxR;
    if (g.skillIncrease) {
        out.skillOptions = [
            ...data.skills.map((s) => ({ key: s.slug, label: s.label, rank: ctx.ranks[s.slug] ?? 0, attr: s.attribute })),
            ...ctx.lores.map((l) => ({ key: l.name, label: l.name, rank: l.rank, attr: "int", lore: true })),
        ].map((o) => ({ ...o, ok: o.rank < maxR }));
        if (!plan.skillInc) out.issues.push(["skills", "Choose a skill to increase."]);
    }

    // attribute boosts
    if (g.boosts) {
        if ((plan.boosts ?? []).length < 4) out.issues.push(["boosts", `${4 - (plan.boosts ?? []).length} attribute boost${4 - (plan.boosts ?? []).length === 1 ? "" : "s"} left to place.`]);
        out.intUp = (plan.boosts ?? []).includes("int") && (ctx.mods.int ?? 0) < 4;
        if (out.intUp && (plan.intSkills ?? []).length < 1) out.issues.push(["skills", "Intelligence went up, so train one more skill."]);
    }
    const conAfter = (ctx.mods.con ?? 0) + ((plan.boosts ?? []).includes("con") && (ctx.mods.con ?? 0) < 4 ? 1 : 0);
    out.hpGain = g.hp + conAfter + (conAfter > (ctx.mods.con ?? 0) ? L - 1 : 0);

    // spells
    out.spellRanks = [];
    if (ctx.caster && Object.keys(g.spells).length) {
        for (const [r, info] of Object.entries(g.spells)) {
            const rank = Number(r);
            const granted = info.opened ? grantedSpellAtRank(ctx.subDoc, rank) : null;
            const grantedDoc = granted ? await data.doc(granted) : null;
            const pick = info.add - (grantedDoc ? 1 : 0);
            const chosen = plan.spells[rank] ?? [];
            const pool = data.spells.filter((s) => {
                const tr = s.system?.traits ?? {};
                if ((tr.value ?? []).includes("cantrip") || (tr.value ?? []).includes("focus")) return false;
                if ((s.system?.level?.value ?? 0) !== rank) return false;
                if (ctx.tradition && !(tr.traditions ?? []).includes(ctx.tradition)) return false;
                if (ctx.known.has(s.uuid) || ctx.knownNames.has(s.name)) return false;
                return visible(s, chosen.includes(s.uuid));
            });
            out.spellRanks.push({ rank, pick, granted: grantedDoc, chosen, pool, opened: info.opened, total: slots(L, rank) });
            if (chosen.length < pick) out.issues.push(["spells", `${pick - chosen.length} ${ORD[rank]}-rank spell${pick - chosen.length === 1 ? "" : "s"} left to learn.`]);
        }
    }
    for (const s of out.slots) if (!s.value) out.issues.push(["feats", `Choose ${/^[aeiou]/i.test(s.key) ? "an" : "a"} ${s.key} feat.`]);
    for (const n of tree.nodes) if (n.answer === null && n.options) out.issues.push([n.section === "features" ? "features" : "feats", `${n.itemName}: ${n.prompt}`]);
    return out;
}

/* ------------------------------------------------------------------------------------------------
 * Apply a level to an actor
 * ---------------------------------------------------------------------------------------------- */
async function srcOf(data, uuid) {
    const doc = await data.doc(uuid);
    if (!doc) throw new Error(`Could not load ${uuid}`);
    return game.items.fromCompendium(doc, { clearFolder: true });
}

export async function applyLevel(data, actor, plan, { snapshot = false } = {}) {
    const ctx = await ctxFromActor(data, actor);
    const L = ctx.level;
    const g = gainsAt(ctx.cls, L);
    const oldMax = actor.system.attributes?.hp?.max ?? 0;
    const oldHP = actor.system.attributes?.hp?.value ?? 0;

    if (snapshot) {
        const snap = actor.toObject();
        if (snap.flags?.[MODULE_ID]) delete snap.flags[MODULE_ID].undo;
        await actor.setFlag(MODULE_ID, "undo", { from: L - 1, to: L, at: Date.now(), data: JSON.stringify(snap) });
    }

    FORGE_RUN.answers = { ...(FORGE_RUN.answers ?? {}), ...plan.answers };
    try {
        // Level first: the system adds this level's class features (and runs their choices)
        const upd = { "system.details.level.value": L };
        const xp = actor.system.details?.xp;
        if (xp && typeof xp.value === "number" && xp.value >= (xp.max ?? 1000)) upd["system.details.xp.value"] = xp.value - (xp.max ?? 1000);
        if (g.boosts) upd[`system.build.attributes.boosts.${L}`] = (plan.boosts ?? []).slice(0, 4);
        if (g.skillIncrease && plan.skillInc && plan.skillInc in (ctx.ranks ?? {})) upd[`system.skills.${plan.skillInc}.rank`] = Math.min(4, (ctx.ranks[plan.skillInc] ?? 0) + 1);
        for (const s of plan.intSkills ?? []) if ((ctx.ranks[s] ?? 0) < 1) upd[`system.skills.${s}.rank`] = 1;
        await actor.update(upd);

        // Lore increase
        if (g.skillIncrease && plan.skillInc && !(plan.skillInc in (ctx.ranks ?? {}))) {
            const lore = ctx.lores.find((l) => l.name === plan.skillInc);
            if (lore?.id) await actor.updateEmbeddedDocuments("Item", [{ _id: lore.id, "system.proficient.value": Math.min(4, lore.rank + 1) }]);
        }

        // Feats in this level's slots
        for (const key of featSlotKeys(g)) {
            const uuid = plan.feats[key];
            if (!uuid) continue;
            const src = await srcOf(data, uuid);
            src.system.location = `${key}-${L}`;
            src.system.level = { ...(src.system.level ?? {}), taken: L };
            await actor.createEmbeddedDocuments("Item", [src]);
        }

        // Spells
        const entry = (actor.itemTypes?.spellcastingEntry ?? []).find((e) => e.system.prepared?.value === "spontaneous");
        if (entry && Object.keys(g.spells).length) {
            const slotUpd = {};
            for (let r = 1; r <= 10; r++) {
                const n = slots(L, r);
                if (n > 0) { slotUpd[`system.slots.slot${r}.max`] = n; slotUpd[`system.slots.slot${r}.value`] = n; }
            }
            await actor.updateEmbeddedDocuments("Item", [{ _id: entry.id, ...slotUpd }]);
            const add = [];
            for (const [r, info] of Object.entries(g.spells)) {
                const rank = Number(r);
                const uuids = [...(plan.spells[rank] ?? [])];
                if (info.opened) { const gs = grantedSpellAtRank(ctx.subDoc, rank); if (gs && await data.doc(gs)) uuids.unshift(gs); }
                for (const u of uuids) {
                    const src = await srcOf(data, u);
                    src.system.location = { value: entry.id, heightenedLevel: rank };
                    add.push(src);
                }
            }
            if (add.length) await actor.createEmbeddedDocuments("Item", add);
        }

        // Keep damage taken: raise current HP by the max HP gained
        const newMax = actor.system.attributes?.hp?.max ?? oldMax;
        if (newMax > oldMax) await actor.update({ "system.attributes.hp.value": Math.min(newMax, oldHP + (newMax - oldMax)) });
    } finally {
        FORGE_RUN.answers = null;
    }
    return actor;
}

/** Restore the snapshot taken before the last level up */
export async function undoLevel(actor) {
    const undo = actor.getFlag(MODULE_ID, "undo");
    if (!undo?.data) throw new Error("There's no level up to undo.");
    const snap = JSON.parse(undo.data);
    delete snap._id;
    snap.flags ??= {};
    snap.flags[MODULE_ID] = { ...(snap.flags[MODULE_ID] ?? {}), undo: null };
    await actor.update(snap, { diff: false, recursive: false });
    return undo.from;
}

export function undoInfo(actor) {
    const u = actor?.getFlag?.(MODULE_ID, "undo");
    if (!u?.data) return null;
    const level = actor.level ?? actor.system.details.level.value;
    return u.to === level ? u : null;
}

export { ORD, localize };
