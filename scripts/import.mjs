/**
 * Import a character from Pathbuilder-format JSON.
 *
 * Hephaistos 2E (sf2e.hephaistos.online) exports this format from its "Pathmuncher" download, and so does the Forge's own
 * JSON export. The file is turned into a Forge draft, which opens in the creator so the player can check every step
 * before the actor is built.
 */
import { ATTRS, priceCredits, sluggify } from "./data.mjs";
import { blankState, derive } from "./model.mjs";
import { blankPlan, ctxFromCreator, deriveLevel, featSlotKeys, gainsAt, grantedSpellAtRank, maxSkillRank } from "./levels.mjs";

export const MAX_IMPORT_LEVEL = 20;

/** Item grades by potency and striking/resilient step (as Pathmuncher reads them) */
const GRADES = [
    { type: "commercial", pot: 0, two: 0 }, { type: "tactical", pot: 1, two: 0 }, { type: "advanced", pot: 1, two: 1 },
    { type: "superior", pot: 2, two: 1 }, { type: "elite", pot: 2, two: 2 }, { type: "ultimate", pot: 3, two: 2 }, { type: "paragon", pot: 3, two: 3 },
];

/* ---------------- name matching ---------------- */
const norm = (s) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const normFull = (s) => String(s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Find a document or index entry by name: exact, then without parentheses, then a unique prefix match. */
export function findByName(list, name, filter = () => true) {
    if (!name) return null;
    const pool = list.filter(filter);
    const full = normFull(name);
    let hit = pool.find((e) => normFull(e.name) === full);
    if (hit) return hit;
    const n = norm(name);
    if (!n) return null;
    hit = pool.find((e) => norm(e.name) === n);
    if (hit) return hit;
    const pre = pool.filter((e) => norm(e.name).startsWith(n + " ") || n.startsWith(norm(e.name) + " "));
    return pre.length === 1 ? pre[0] : null;
}

/** Pull the build out of whatever the user pasted: a full export, the inner build, or a JSON string. */
export function parseBuild(input) {
    let obj = input;
    if (typeof obj === "string") {
        const txt = obj.trim();
        if (!txt) throw new Error("The file is empty.");
        try { obj = JSON.parse(txt); } catch (err) { throw new Error("That isn't valid JSON. Export the character from Hephaistos with the Pathmuncher option, then try again."); }
    }
    const build = obj?.build ?? obj;
    if (!build || typeof build !== "object" || !build.class && !build.ancestry && !build.name) {
        throw new Error("This doesn't look like a character export. In Hephaistos, open the character, click the download button, and choose Pathmuncher.");
    }
    return build;
}

/** Credits from the export's money block. Hephaistos stores credits in "sp". */
export function creditsFrom(money) {
    if (!money) return 0;
    if (typeof money.credits === "number") return money.credits;
    return Math.round(((money.cp ?? 0) / 10 + (money.sp ?? 0) + (money.gp ?? 0) * 10 + (money.pp ?? 0) * 100) * 10) / 10;
}

const rankOf = (prof) => Math.max(0, Math.min(4, Math.floor((Number(prof) || 0) / 2)));

/**
 * Turn a build into Forge state.
 * @returns {{ S: object, report: { source: string, placed: string[], missing: string[], notes: string[] } }}
 */
export async function importBuild(data, input, { source = "Hephaistos" } = {}) {
    const b = parseBuild(input);
    const S = blankState();
    const missing = [];
    const notes = [];
    const placed = [];
    const miss = (what, name) => { if (name) missing.push(`${what}: ${name}`); };

    S.name = b.name ?? "";
    S.gender = b.gender ?? "";
    S.age = b.age != null ? String(b.age) : "";
    S.notes = b.deity ? `Deity: ${b.deity}` : "";
    S.level = Math.max(1, Math.min(MAX_IMPORT_LEVEL, Number(b.level) || 1));

    /* ---- ancestry, heritage, background, class ---- */
    const anc = findByName(data.ancestries, b.ancestry);
    if (anc) S.anc = anc.uuid; else miss("Ancestry", b.ancestry);
    const herName = b.heritage ?? (b.feats ?? []).find((f) => /heritage/i.test(f?.[2] ?? ""))?.[0];
    const ancSlug = anc?.system?.slug ?? (anc ? sluggify(anc.name) : null);
    const her = findByName(data.heritages, herName, (h) => !h.system?.ancestry || !ancSlug || (h.system.ancestry.slug ?? sluggify(h.system.ancestry.name ?? "")) === ancSlug)
        ?? findByName(data.heritages, herName);
    if (her) S.her = her.uuid; else miss("Heritage", herName);
    const bg = findByName(data.backgrounds, b.background);
    if (bg) S.bg = bg.uuid; else miss("Background", b.background);
    const cls = findByName(data.classes, b.class);
    if (cls) S.cls = cls.uuid; else miss("Class", b.class);
    if (b.keyability && ATTRS.includes(b.keyability)) S.key = b.keyability;

    /* ---- attribute boosts ---- */
    const br = b.abilities?.breakdown ?? {};
    const ancBoosts = [...(br.ancestryBoosts ?? []), ...(br.ancestryFree ?? [])].filter((a) => ATTRS.includes(a));
    if (anc) {
        const slotsA = Object.entries(anc.system.boosts ?? {});
        const fixed = slotsA.filter(([, s]) => (s.value ?? []).length === 1).map(([, s]) => s.value[0]);
        const flaws = Object.values(anc.system.flaws ?? {}).filter((f) => (f.value ?? []).length === 1).map((f) => f.value[0]);
        const noFlaws = !(br.ancestryFlaws ?? []).length && flaws.length;
        if (noFlaws && fixed.some((a) => !ancBoosts.includes(a)) && ancBoosts.length >= 2) {
            S.alt = true;
            S.altBoosts = ancBoosts.slice(0, 2);
        } else {
            const left = [...ancBoosts];
            for (const a of fixed) { const i = left.indexOf(a); if (i >= 0) left.splice(i, 1); }
            for (const [k, s] of slotsA) {
                if ((s.value ?? []).length <= 1) continue;
                const i = left.findIndex((a) => s.value.includes(a));
                if (i >= 0) { S.ancSel[k] = left[i]; left.splice(i, 1); }
            }
        }
    }
    if (bg) {
        const left = (br.backgroundBoosts ?? []).filter((a) => ATTRS.includes(a));
        for (const [k, s] of Object.entries(bg.system.boosts ?? {})) {
            if ((s.value ?? []).length <= 1) continue;
            const i = left.findIndex((a) => s.value.includes(a));
            if (i >= 0) { S.bgSel[k] = left[i]; left.splice(i, 1); }
        }
    }
    if (!S.key && (br.classBoosts ?? []).length) S.key = br.classBoosts[0];
    const lvlBoosts = br.mapLevelledBoosts ?? {};
    S.free = (lvlBoosts[1] ?? lvlBoosts["1"] ?? []).filter((a) => ATTRS.includes(a)).slice(0, 4);
    for (const [L, list] of Object.entries(lvlBoosts)) {
        const lv = Number(L);
        if (lv > 1 && lv <= S.level) (S.levels[lv] ??= blankPlan()).boosts = list.filter((a) => ATTRS.includes(a)).slice(0, 4);
    }
    for (let L = 2; L <= S.level; L++) S.levels[L] ??= blankPlan();

    /* ---- languages ---- */
    for (const l of b.languages ?? []) {
        const hit = data.languages.find((x) => norm(x.label) === norm(l) || x.slug === sluggify(l));
        if (hit) S.langs.push(hit.slug); else miss("Language", l);
    }

    /* ---- feats: sort into slots ---- */
    const feats = (b.feats ?? []).filter((f) => Array.isArray(f) && f[0] && f[0] !== "Not Selected" && !/heritage/i.test(f[2] ?? ""));
    const featDoc = (name) => findByName(data.feats, name);
    // What the chosen ancestry/background/class already grant, so we don't add those twice
    let D = await derive(data, S);
    const grantedNames = () => new Set([
        // only things something else grants (v.via), not the feats we placed ourselves
        ...D.visited.filter((v) => v.via).map((v) => norm(v.doc.name)),
        ...[cls, anc, bg].flatMap((d) => Object.values(d?.system?.items ?? {}).map((e) => norm(e.name))),
    ]);
    const slotFor = { "ancestry feat": "ancestry", "class feat": "class", "archetype feat": "class", "skill feat": "skill", "general feat": "general" };
    const leftovers = [];
    let granted = grantedNames();
    for (const f of feats) {
        const [name, extra, type, lvlRaw] = f;
        const lvl = Math.max(1, Number(lvlRaw) || 1);
        if (granted.has(norm(name))) continue;
        const doc = featDoc(name);
        if (!doc) { miss("Feat", extra ? `${name} (${extra})` : name); continue; }
        const slot = slotFor[String(type ?? "").toLowerCase()] ?? null;
        if (lvl === 1) {
            if (slot === "ancestry" && !S.feats.anc) { S.feats.anc = doc.uuid; placed.push(name); continue; }
            if (slot === "class" && !S.feats.cls) { S.feats.cls = doc.uuid; placed.push(name); continue; }
            S.extra.push(doc.uuid); placed.push(name);
            continue;
        }
        if (lvl > S.level) continue;
        const g = gainsAt(cls, lvl);
        const keys = featSlotKeys(g);
        const plan = S.levels[lvl];
        if (slot && keys.includes(slot) && !plan.feats[slot]) { plan.feats[slot] = doc.uuid; placed.push(name); continue; }
        leftovers.push({ name, doc, lvl, extra });
    }
    // A feat whose level didn't have a matching slot: try any free slot of that kind at or after its level
    for (const lf of leftovers) {
        const t = normFull(lf.doc.system?.category ?? "");
        let done = false;
        for (let L = lf.lvl; L <= S.level && !done; L++) {
            const keys = featSlotKeys(gainsAt(cls, L));
            for (const k of keys) {
                if (S.levels[L].feats[k]) continue;
                const fits = k === t || (k === "general" && (t === "skill" || (lf.doc.system?.traits?.value ?? []).includes("general")));
                if (fits) { S.levels[L].feats[k] = lf.doc.uuid; placed.push(lf.name); done = true; break; }
            }
        }
        if (!done) notes.push(`${lf.name} (level ${lf.lvl}) didn't fit a feat slot. Add it on the character sheet after the character is built.`);
    }

    /* ---- choices (class paths, feat options): match against what the export lists ---- */
    const hints = new Set([...(b.specials ?? []), ...feats.map((f) => f[1]).filter(Boolean), ...feats.map((f) => f[0]), b.deity].filter(Boolean).map(norm));
    const featExtras = new Map(feats.filter((f) => f[1]).map((f) => [norm(f[0]), norm(f[1])]));
    const pickAnswer = (node) => {
        if (!node.options?.length) return undefined;
        const own = featExtras.get(norm(node.itemName));
        const byLabel = (h) => node.options.filter((o) => norm(o.label) === h);
        if (own) { const m = byLabel(own); if (m.length === 1) return m[0].value; }
        const exact = node.options.filter((o) => hints.has(norm(o.label)));
        if (exact.length === 1) return exact[0].value;
        // "Healing" matching "Healing Connection" and the like
        const loose = node.options.filter((o) => { const l = norm(o.label); return l.length >= 4 && [...hints].some((h) => h.startsWith(l + " ") || h.endsWith(" " + l)); });
        return loose.length === 1 ? loose[0].value : undefined;
    };
    for (let pass = 0; pass < 5; pass++) {
        D = await derive(data, S);
        let changed = false;
        for (const n of D.unanswered) {
            const v = pickAnswer(n);
            if (v !== undefined) { S.answers[n.key] = v; changed = true; }
        }
        if (!changed) break;
    }
    granted = grantedNames();
    // Remove bonus feats that turned out to be granted once choices were made
    S.extra = S.extra.filter((u) => !granted.has(norm(data.entry(u)?.name)));

    /* ---- skills ---- */
    const prof = b.proficiencies ?? {};
    const want = {};
    for (const s of data.skills) { const r = rankOf(prof[s.slug]); if (r > 0) want[s.slug] = r; }
    const lvl1 = Object.keys(want).filter((s) => !D.autoSkills[s]);
    const picks = D.skillPicks ?? lvl1.length;
    S.skills = lvl1.slice(0, Math.max(picks, 0));
    const extraTrained = lvl1.slice(S.skills.length);
    // Extra trained skills came from Intelligence boosts at higher levels
    for (let L = 5; L <= S.level && extraTrained.length; L += 5) {
        const plan = S.levels[L];
        if (plan?.boosts?.includes("int")) plan.intSkills = [extraTrained.shift()];
    }
    if (extraTrained.length) S.skills.push(...extraTrained);
    // Lores
    const bgLores = new Set((bg?.system?.trainedSkills?.lore ?? []).map((l) => norm(l.replace(/lore$/i, ""))));
    const loreRanks = {};
    for (const [n, p] of b.lores ?? []) {
        const base = String(n).replace(/\s*lore$/i, "");
        loreRanks[`${base} Lore`] = rankOf(p);
        if (!bgLores.has(norm(base))) S.lores.push(base);
    }
    // Skill increases, earliest level first, respecting the rank cap at each level
    const cur = {};
    for (const s of Object.keys(want)) cur[s] = 1;
    for (const l of Object.keys(loreRanks)) cur[l] = 1;
    const target = { ...want, ...loreRanks };
    for (let L = 2; L <= S.level; L++) {
        if (!gainsAt(cls, L).skillIncrease) continue;
        const cands = Object.keys(target).filter((s) => target[s] > cur[s] && cur[s] + 1 <= maxSkillRank(L)).sort((a, c) => cur[a] - cur[c]);
        if (!cands.length) continue;
        S.levels[L].skillInc = cands[0];
        cur[cands[0]]++;
    }
    for (const s of Object.keys(target)) if (target[s] > cur[s]) notes.push(`${s} ended up at a lower rank than in the export. Raise it on the sheet if needed.`);

    /* ---- spells ---- */
    D = await derive(data, S);
    const caster = (b.spellCasters ?? []).find((c) => norm(c.name) === norm(b.class)) ?? (b.spellCasters ?? []).find((c) => !c.innate && c.spellcastingType === "spontaneous");
    if (caster && D.caster) {
        const byRank = {};
        for (const blk of caster.spells ?? []) {
            for (const nm of blk.list ?? []) {
                const sp = findByName(data.spells, nm);
                if (!sp) { miss("Spell", nm); continue; }
                (byRank[blk.spellLevel] ??= []).push(sp.uuid);
            }
        }
        const skip = new Set([D.grantedCantrip?.uuid, D.grantedFirst?.uuid].filter(Boolean));
        const take = (r, n) => { const list = (byRank[r] ?? []).filter((u) => !skip.has(u)); const out = list.splice(0, n); byRank[r] = list; out.forEach((u) => skip.add(u)); return out; };
        S.spells.cantrips = take(0, 4);
        S.spells.first = take(1, 2);
        for (let L = 2; L <= S.level; L++) {
            const g = gainsAt(D.cls, L);
            for (const [r, info] of Object.entries(g.spells)) {
                const rank = Number(r);
                const gr = info.opened ? grantedSpellAtRank(D.subDoc, rank) : null;
                const grDoc = gr ? await data.doc(gr) : null;
                if (grDoc) { skip.add(gr); skip.add(grDoc.uuid); }
                S.levels[L].spells[rank] = take(rank, info.add - (grDoc ? 1 : 0));
            }
        }
        for (const [r, list] of Object.entries(byRank)) for (const u of list) notes.push(`${data.entry(u)?.name ?? u} (rank ${r}) didn't fit a spell slot. Add it on the sheet if you still want it.`);
    }

    /* ---- level choices (class features and feats at higher levels) ---- */
    for (let L = 2; L <= S.level; L++) {
        for (let pass = 0; pass < 3; pass++) {
            const LV = await deriveLevel(data, ctxFromCreator(data, S, D, L), S.levels[L]);
            let changed = false;
            for (const n of LV.choices) {
                if (n.answer !== null) continue;
                const v = pickAnswer(n);
                if (v !== undefined) { S.levels[L].answers[n.key] = v; changed = true; }
            }
            if (!changed) break;
        }
    }

    /* ---- gear and credits ---- */
    const equip = (name) => findByName(data.equipment, name);
    let spent = 0;
    const cost = (uuid, q = 1) => { spent += priceCredits(data.entry(uuid)?.system?.price) * q; };
    // Upgrades (force fields, weapon fusions...) come in each item's "runes" list; grade from "grade" or the potency numbers
    const upgradesOf = (it, q = 1) => {
        const out = [];
        for (const nm of it.runes ?? []) {
            if (!nm || typeof nm !== "string") continue;
            const hit = equip(nm);
            if (!hit) { miss("Upgrade", `${nm} (on ${it.name})`); continue; }
            out.push(hit.uuid);
            cost(hit.uuid, q);
        }
        return out;
    };
    const gradeOf = (it, kind) => {
        if (typeof it.grade === "string" && it.grade) return it.grade.toLowerCase();
        const pot = Number(it.pot) || 0;
        const second = kind === "armor" ? ["", "resilient", "greater resilient", "major resilient"].indexOf(it.res ?? "") : ["", "striking", "greater striking", "major striking"].indexOf(it.str ?? "");
        const hit = GRADES.find((g) => g.pot === pot && g.two === Math.max(0, second));
        return hit && hit.type !== "commercial" ? hit.type : null;
    };
    const armorList = (b.armor ?? []).filter((a) => a?.name);
    const worn = armorList.find((a) => a.worn && a.prof !== "shield") ?? armorList.find((a) => a.prof !== "shield");
    for (const a of armorList) {
        const hit = equip(a.display || a.name) ?? equip(a.name);
        if (!hit) { miss("Armor", a.name); continue; }
        const up = upgradesOf(a, a.qty ?? 1);
        const grade = gradeOf(a, "armor");
        if (hit.type === "shield" && !S.gear.shield) S.gear.shield = hit.uuid;
        else if (a === worn && hit.type === "armor" && !S.gear.armor) { S.gear.armor = hit.uuid; S.gear.armorUp = up; S.gear.armorGrade = grade; }
        else S.gear.items.push({ uuid: hit.uuid, q: a.qty ?? 1, up, grade });
        cost(hit.uuid, a.qty ?? 1);
    }
    for (const w of b.weapons ?? []) {
        if (!w?.name || w.prof === "unarmed" || /^fist$/i.test(w.name)) continue;
        const hit = equip(w.display || w.name) ?? equip(w.name);
        if (!hit) { miss("Weapon", w.name); continue; }
        S.gear.weapons.push({ uuid: hit.uuid, q: w.qty ?? 1, up: upgradesOf(w, w.qty ?? 1), grade: gradeOf(w, "weapon") });
        cost(hit.uuid, w.qty ?? 1);
    }
    for (const e of b.equipment ?? []) {
        const [name, qty] = Array.isArray(e) ? e : [e?.name, e?.qty];
        if (!name) continue;
        const hit = equip(name);
        if (!hit) { miss("Item", name); continue; }
        const q = Number(qty) || 1;
        const same = S.gear.items.find((i) => i.uuid === hit.uuid);
        if (same) same.q += q; else S.gear.items.push({ uuid: hit.uuid, q });
        cost(hit.uuid, q);
    }
    S.startCredits = Math.round((creditsFrom(b.money) + spent) * 10) / 10;

    S.imported = { source, at: Date.now(), name: S.name, level: S.level, missing, notes };
    return { S, report: { source, placed, missing, notes } };
}
