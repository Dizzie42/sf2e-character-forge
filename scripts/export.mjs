/**
 * Export a character as Pathbuilder-format JSON (the same shape Hephaistos 2E exports and Pathmuncher reads,
 * so it can be imported back into the Forge in any world) or as a printable PDF sheet.
 */
import { ATTRS, ATTR_LABEL, localize } from "./data.mjs";

const MODULE_ID = "sf2e-character-forge";
const RANK_LETTER = ["U", "T", "E", "M", "L"];
const SIZES = { tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5 };
const SIZE_NAME = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];
const TYPE_LABEL = { ancestry: "Ancestry Feat", class: "Class Feat", skill: "Skill Feat", general: "General Feat", bonus: "Awarded Feat" };
const FEATURE_CATS = new Set(["classfeature", "ancestryfeature", "pfsboon", "deityboon", "curse", "calling"]);

const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const items = (actor, type) => actor.itemTypes?.[type] ?? [];
const safeName = (s) => String(s || "character").replace(/[\\/:*?"<>|]+/g, "").trim() || "character";

/* ------------------------------------------------------------------------------------------------
 * Reading an actor (works on any SF2e character, not only ones the Forge made)
 * ---------------------------------------------------------------------------------------------- */
function attrMod(actor, a) { return num(actor.system?.abilities?.[a]?.mod ?? actor.abilities?.[a]?.mod); }
function stat(s) { return s ? { mod: num(s.mod ?? s.totalModifier ?? s.value), rank: num(s.rank) } : { mod: 0, rank: 0 }; }
function skillStat(actor, slug) {
    const s = actor.skills?.[slug] ?? actor.system?.skills?.[slug];
    return stat(s);
}
function speedOf(actor) {
    const a = actor.system?.attributes ?? {};
    return num(a.speed?.total ?? a.speed?.value ?? actor.system?.movement?.speeds?.land?.value, 25);
}
function levelOf(actor) { return num(actor.level ?? actor.system?.details?.level?.value, 1); }
function featLevel(f) {
    const taken = f.system?.level?.taken;
    if (typeof taken === "number") return taken;
    const m = /-(\d+)$/.exec(typeof f.system?.location === "string" ? f.system.location : "");
    return m ? Number(m[1]) : num(f.system?.level?.value, 1);
}
function selectionLabel(f) {
    const sel = f.flags?.system?.rulesSelections ?? f.flags?.pf2e?.rulesSelections ?? f.flags?.sf2e?.rulesSelections ?? {};
    for (const v of Object.values(sel)) {
        if (typeof v !== "string") continue;
        if (/^Compendium\./.test(v)) { try { const d = fromUuidSync(v); if (d?.name) return d.name; } catch (e) { /* ignore */ } continue; }
        return v.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return null;
}
function spellRank(s) {
    if ((s.system?.traits?.value ?? []).includes("cantrip")) return 0;
    return num(s.system?.location?.heightenedLevel ?? s.rank ?? s.system?.level?.value, 1);
}
/** Names of upgrades installed in an item (SF2e stores them as subitems) */
function subNames(it) {
    const subs = it.subitems?.contents ?? (Array.isArray(it.subitems) ? it.subitems : null) ?? it.system?.subitems ?? [];
    return subs.map((x) => x?.name).filter(Boolean);
}
function credits(actor) {
    const c = actor.inventory?.currency ?? actor.inventory?.coins;
    if (c && typeof c.credits === "number") return c.credits;
    if (c) return num(c.sp) + num(c.gp) * 10 + num(c.pp) * 100 + num(c.cp) / 10;
    return 0;
}
function languages(actor) {
    const cfg = CONFIG.PF2E?.languages ?? {};
    return (actor.system?.details?.languages?.value ?? []).map((l) => localize(cfg[l] ?? l));
}

/** Pathbuilder-format export of an actor */
export function exportBuild(actor) {
    const sys = actor.system ?? {};
    const ba = sys.build?.attributes ?? {};
    const boosts = ba.boosts ?? {};
    const lvl = levelOf(actor);
    const size = sys.traits?.size?.value ?? "med";

    const feats = [];
    const specials = [];
    for (const f of items(actor, "feat")) {
        const cat = f.system?.category ?? "";
        if (FEATURE_CATS.has(cat)) { specials.push(f.name); continue; }
        const slotted = !!f.system?.location && typeof f.system.location === "string";
        feats.push([f.name, selectionLabel(f), slotted ? (TYPE_LABEL[cat] ?? "Awarded Feat") : "Awarded Feat", featLevel(f)]);
    }
    feats.sort((a, b) => a[3] - b[3]);

    const prof = {
        classDC: num(actor.classDC?.rank, 1) * 2,
        perception: stat(actor.perception ?? sys.perception).rank * 2,
        fortitude: stat(actor.saves?.fortitude ?? sys.saves?.fortitude).rank * 2,
        reflex: stat(actor.saves?.reflex ?? sys.saves?.reflex).rank * 2,
        will: stat(actor.saves?.will ?? sys.saves?.will).rank * 2,
    };
    for (const k of ["heavy", "medium", "light", "unarmored"]) prof[k] = num(sys.proficiencies?.defenses?.[k]?.rank) * 2;
    for (const k of ["advanced", "martial", "simple", "unarmed"]) prof[k] = num(sys.proficiencies?.attacks?.[k]?.rank) * 2;
    for (const t of ["Arcane", "Divine", "Occult", "Primal"]) prof[`casting${t}`] = 0;
    for (const slug of Object.keys(CONFIG.PF2E?.skills ?? {})) prof[slug] = skillStat(actor, slug).rank * 2;

    const entries = items(actor, "spellcastingEntry");
    const spells = items(actor, "spell");
    const spellCasters = [];
    const focus = {};
    for (const e of entries) {
        const type = e.system?.prepared?.value ?? "spontaneous";
        const trad = e.system?.tradition?.value ?? "";
        const ability = e.system?.ability?.value ?? "wis";
        const pr = num(e.system?.proficiency?.value, 1) * 2;
        const mine = spells.filter((s) => s.system?.location?.value === e.id);
        if (trad && `casting${trad[0].toUpperCase()}${trad.slice(1)}` in prof) prof[`casting${trad[0].toUpperCase()}${trad.slice(1)}`] = Math.max(prof[`casting${trad[0].toUpperCase()}${trad.slice(1)}`], pr);
        if (type === "focus") {
            const bucket = ((focus[trad] ??= {})[ability] ??= { abilityBonus: attrMod(actor, ability), proficiency: pr, itemBonus: 0, focusCantrips: [], focusSpells: [] });
            for (const s of mine) (spellRank(s) === 0 ? bucket.focusCantrips : bucket.focusSpells).push(s.name);
            continue;
        }
        const byRank = new Map();
        for (const s of mine) { const r = spellRank(s); if (!byRank.has(r)) byRank.set(r, []); byRank.get(r).push(s.name); }
        const perDay = [];
        for (let r = 0; r <= 10; r++) perDay.push(num(e.system?.slots?.[`slot${r}`]?.max));
        while (perDay.length > 1 && perDay.at(-1) === 0) perDay.pop();
        spellCasters.push({
            name: actor.class?.name && type === "spontaneous" && spellCasters.length === 0 ? actor.class.name : e.name,
            magicTradition: trad, spellcastingType: type, ability, proficiency: pr, focusPoints: 0, innate: type === "innate",
            perDay, spells: [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([spellLevel, list]) => ({ spellLevel, list })), prepared: [], blendedSpells: [],
        });
    }

    const equipment = [];
    const weapons = [];
    const armor = [];
    const physical = ["weapon", "armor", "shield", "equipment", "consumable", "ammo", "backpack", "treasure", "augmentation", "upgrade"];
    for (const type of physical) {
        for (const it of items(actor, type)) {
            const qty = num(it.system?.quantity, 1);
            if (type === "treasure" && (it.isCurrency || it.system?.stackGroup === "credits" || /credstick|^credits?$/i.test(it.name))) continue;
            if (type === "weapon") {
                const strike = (sys.actions ?? []).find((a) => a.item?.id === it.id);
                const dmg = it.system?.damage ?? {};
                weapons.push({ name: it.name, qty, prof: it.system?.category ?? "simple", die: dmg.die ? `${dmg.dice ?? 1}${dmg.die}` : "", pot: 0, str: "", mat: null, display: it.name, runes: subNames(it),
                    damageType: String(dmg.damageType ?? "").charAt(0).toUpperCase(), attack: num(strike?.totalModifier), damageBonus: 0, extraDamage: [], increasedDice: false, isInventor: false, grade: it.system?.grade ?? null });
            } else if (type === "armor" || type === "shield") {
                armor.push({ name: it.name, qty, prof: type === "shield" ? "shield" : (it.system?.category ?? "light"), pot: 0, res: "", mat: null, display: it.name,
                    worn: !!(it.isEquipped ?? it.system?.equipped?.inSlot), runes: subNames(it), grade: it.system?.grade ?? null });
            } else {
                const row = [it.name, qty];
                if (it.isInvested ?? it.system?.equipped?.invested) row.push("Invested");
                equipment.push(row);
            }
        }
    }

    const lores = items(actor, "lore").map((l) => [l.name.replace(/\s*lore$/i, ""), num(l.system?.proficient?.value, 1) * 2]);
    const levelled = {};
    for (const L of [1, 5, 10, 15, 20]) if ((boosts[L] ?? []).length) levelled[L] = [...boosts[L]];

    return {
        success: true,
        build: {
            name: actor.name, class: actor.class?.name ?? "", level: lvl,
            ancestry: actor.ancestry?.name ?? "", heritage: actor.heritage?.name ?? null, background: actor.background?.name ?? "",
            gender: sys.details?.gender?.value ?? "", age: sys.details?.age?.value ?? "", deity: actor.deity?.name ?? "",
            size: SIZES[size] ?? 2, sizeName: SIZE_NAME[SIZES[size] ?? 2], keyability: sys.details?.keyability?.value ?? boosts.class ?? "",
            languages: languages(actor), rituals: [], resistances: [],
            attributes: { ancestryhp: num(actor.ancestry?.system?.hp), classhp: num(actor.class?.system?.hp), bonushp: 0, bonushpPerLevel: 0, speed: speedOf(actor), speedBonus: 0 },
            abilities: {
                ...Object.fromEntries(ATTRS.map((a) => [a, 10 + 2 * attrMod(actor, a)])),
                breakdown: {
                    ancestryFree: [], ancestryBoosts: [...(boosts.ancestry ?? [])], ancestryFlaws: [...(ba.flaws?.ancestry ?? [])],
                    backgroundBoosts: [...(boosts.background ?? [])], classBoosts: boosts.class ? [boosts.class] : [], mapLevelledBoosts: levelled,
                },
            },
            proficiencies: prof, feats, specials, lores,
            equipmentContainers: {}, equipment, weapons,
            money: { cp: 0, sp: credits(actor), gp: 0, pp: 0 },
            armor, spellCasters,
            focusPoints: num(sys.resources?.focus?.max), focus,
            formula: [], pets: [], familiars: [],
            acTotal: { acProfBonus: 0, acAbilityBonus: 0, acItemBonus: 0, acTotal: num(sys.attributes?.ac?.value), shieldBonus: null },
        },
        forge: { module: game.modules.get(MODULE_ID)?.version ?? "", system: `${game.system.id} ${game.system.version ?? ""}`.trim(), exported: new Date().toISOString() },
    };
}

/* ------------------------------------------------------------------------------------------------
 * Saving files
 * ---------------------------------------------------------------------------------------------- */
function saveFile(data, type, filename) {
    const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
    if (save) return save(data, type, filename);
    const blob = new Blob([data], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function downloadJSON(actor) {
    const data = exportBuild(actor);
    saveFile(JSON.stringify(data, null, 2), "application/json", `${safeName(actor.name)}.json`);
    return data;
}

let jsPDFLoading = null;
function loadJsPDF() {
    if (globalThis.jspdf?.jsPDF) return Promise.resolve(globalThis.jspdf.jsPDF);
    jsPDFLoading ??= new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = new URL("../vendor/jspdf.umd.min.js", import.meta.url).href;
        s.onload = () => (globalThis.jspdf?.jsPDF ? resolve(globalThis.jspdf.jsPDF) : reject(new Error("The PDF library didn't load.")));
        s.onerror = () => { jsPDFLoading = null; reject(new Error("The PDF library didn't load.")); };
        document.head.append(s);
    });
    return jsPDFLoading;
}

/* ------------------------------------------------------------------------------------------------
 * PDF sheet
 * ---------------------------------------------------------------------------------------------- */
export async function sheetData(actor) {
    const sys = actor.system ?? {};
    const sgnN = (n) => (n >= 0 ? `+${n}` : `${n}`);
    const skills = Object.entries(CONFIG.PF2E?.skills ?? {}).map(([slug, s]) => {
        const st = skillStat(actor, slug);
        return { name: localize(typeof s === "string" ? s : s.label), rank: RANK_LETTER[st.rank] ?? "U", mod: sgnN(st.mod) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const lores = items(actor, "lore").map((l) => {
        const st = actor.skills?.[l.slug ?? ""] ?? null;
        const r = num(l.system?.proficient?.value, 1);
        return { name: l.name, rank: RANK_LETTER[r], mod: sgnN(st ? num(st.mod) : attrMod(actor, "int") + r * 2 + levelOf(actor)) };
    });
    const feats = [];
    const features = [];
    for (const f of items(actor, "feat")) {
        const cat = f.system?.category ?? "";
        if (FEATURE_CATS.has(cat)) features.push({ name: f.name, level: num(f.system?.level?.value, 1) });
        else feats.push({ name: f.name, type: (TYPE_LABEL[cat] ?? "Feat").replace(" Feat", ""), level: featLevel(f), extra: selectionLabel(f) });
    }
    feats.sort((a, b) => a.level - b.level || a.type.localeCompare(b.type));
    features.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    const strikes = (sys.actions ?? []).filter((a) => a.type === "strike" || a.item).map((a) => {
        const dmg = a.item?.system?.damage ?? {};
        return { name: a.label ?? a.item?.name ?? "", attack: sgnN(num(a.totalModifier)), damage: dmg.die ? `${dmg.dice ?? 1}${dmg.die} ${dmg.damageType ?? ""}`.trim() : "", traits: (a.item?.system?.traits?.value ?? []).join(", ") };
    });
    const spellGroups = [];
    for (const e of items(actor, "spellcastingEntry")) {
        const mine = items(actor, "spell").filter((s) => s.system?.location?.value === e.id);
        const byRank = new Map();
        for (const s of mine) { const r = spellRank(s); if (!byRank.has(r)) byRank.set(r, []); byRank.get(r).push(s.name); }
        const stat2 = e.statistic ?? null;
        spellGroups.push({
            focus: e.system?.prepared?.value === "focus",
            name: e.name, dc: stat2?.dc?.value ?? null, attack: stat2 ? sgnN(num(stat2.mod ?? stat2.check?.mod)) : null,
            ranks: [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([r, list]) => ({ rank: r, slots: num(e.system?.slots?.[`slot${r}`]?.max), list: list.sort() })),
        });
    }
    const gear = [];
    for (const type of ["armor", "shield", "weapon", "equipment", "consumable", "ammo", "backpack", "augmentation", "upgrade", "treasure"]) {
        for (const it of items(actor, type)) {
            if (type === "treasure" && (it.isCurrency || /credstick|^credits?$/i.test(it.name))) continue;
            gear.push({ name: it.name + (subNames(it).length ? ` (+ ${subNames(it).join(", ")})` : ""), qty: num(it.system?.quantity, 1), worn: !!(it.isEquipped ?? it.system?.equipped?.inSlot) });
        }
    }
    const heritage = actor.heritage?.name;
    return {
        name: actor.name,
        line: [heritage ?? actor.ancestry?.name, actor.background?.name && `${actor.background.name} background`, actor.class?.name && `${actor.class.name} ${levelOf(actor)}`].filter(Boolean).join("  |  "),
        meta: [sys.details?.gender?.value, sys.details?.age?.value && `Age ${sys.details.age.value}`, actor.deity?.name && `Deity: ${actor.deity.name}`, SIZE_NAME[SIZES[sys.traits?.size?.value ?? "med"] ?? 2]].filter(Boolean).join("  |  "),
        level: levelOf(actor),
        key: sys.details?.keyability?.value ?? null,
        attrs: ATTRS.map((a) => ({ key: a, label: ATTR_LABEL[a], mod: sgnN(attrMod(actor, a)) })),
        stats: [
            ["Hit Points", String(num(sys.attributes?.hp?.max))], ["Armor Class", String(num(sys.attributes?.ac?.value))],
            ["Perception", sgnN(stat(actor.perception ?? sys.perception).mod)], ["Fortitude", sgnN(stat(actor.saves?.fortitude ?? sys.saves?.fortitude).mod)],
            ["Reflex", sgnN(stat(actor.saves?.reflex ?? sys.saves?.reflex).mod)], ["Will", sgnN(stat(actor.saves?.will ?? sys.saves?.will).mod)],
            ["Class DC", actor.classDC?.dc?.value != null ? String(actor.classDC.dc.value) : "-"], ["Speed", `${speedOf(actor)} ft`],
        ],
        skills, lores, feats, features, strikes, spellGroups, gear,
        languages: languages(actor),
        credits: credits(actor),
        focus: num(sys.resources?.focus?.max),
        notes: String(sys.details?.biography?.backstory ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    };
}

export async function buildPDF(C) {
    const JsPDF = await loadJsPDF();
    const doc = new JsPDF({ unit: "pt", format: "letter" });
    const W = 612, H = 792, M = 36;
    const INK = [21, 32, 43], MUTED = [90, 105, 120], LINE = [205, 213, 221], ACC = [14, 106, 130], SOFT = [226, 239, 243], SOL = [168, 107, 18];
    const clean = (s) => String(s ?? "").replace(/[‘’′]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, "-").replace(/…/g, "...").replace(/×/g, "x").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
    let y = M;
    let page = 1;
    const color = (c, what) => (what === "fill" ? doc.setFillColor(...c) : what === "draw" ? doc.setDrawColor(...c) : doc.setTextColor(...c));
    const font = (style, size, c) => { doc.setFont("helvetica", style); doc.setFontSize(size); color(c || INK); };
    const text = (s, x, yy, opt) => doc.text(clean(s), x, yy, opt);
    const footer = () => {
        font("normal", 7.5, MUTED);
        text(`${C.name || "Unnamed character"} - Starfinder 2e - Level ${C.level}`, M, H - 18);
        text(`Page ${page}`, W - M, H - 18, { align: "right" });
        text("Made with Starfinder 2e Character Forge", W / 2, H - 18, { align: "center" });
        page++;
    };
    const need = (h) => { if (y + h > H - M) { footer(); doc.addPage(); y = M; } };
    const heading = (label) => {
        y += 8; need(26);
        font("bold", 9, ACC); text(label.toUpperCase(), M, y + 9, { charSpace: 0.8 });
        color(ACC, "draw"); doc.setLineWidth(1.2); doc.line(M, y + 13, W - M, y + 13);
        y += 22;
    };
    const para = (s, x = M, width = W - 2 * M, size = 8.5, c = INK) => {
        font("normal", size, c);
        const lines = doc.splitTextToSize(clean(s), width);
        const h = size * 1.3;
        for (const l of lines) { need(h); text(l, x, y + h - 3); y += h; }
    };
    const box = (x, yy, w, h, label, value, opts = {}) => {
        color(opts.fill || [255, 255, 255], "fill"); color(LINE, "draw"); doc.setLineWidth(0.8);
        doc.roundedRect(x, yy, w, h, 4, 4, "FD");
        font("bold", opts.vsize || 17, opts.vc || INK); text(String(value), x + w / 2, yy + h - 17, { align: "center" });
        font("bold", 6.5, MUTED); text(label.toUpperCase(), x + w / 2, yy + h - 6, { align: "center", charSpace: 0.5 });
    };

    // header
    color(INK, "fill"); doc.rect(0, 0, W, 78, "F");
    color(SOL, "fill"); doc.circle(W - M - 14, 30, 8, "F");
    color([77, 176, 201], "draw"); doc.setLineWidth(1.4); doc.ellipse(W - M - 14, 30, 24, 8, "S");
    font("bold", 22, [255, 255, 255]); text(C.name || "Unnamed character", M, 36);
    font("normal", 10, [200, 214, 224]); text(C.line, M, 54);
    font("normal", 8.5, [150, 170, 186]); text(C.meta, M, 68);
    y = 92;

    // attributes
    const aw = (W - 2 * M - 5 * 8) / 6;
    C.attrs.forEach((a, i) => {
        const key = C.key === a.key;
        box(M + i * (aw + 8), y, aw, 44, a.label + (key ? " (key)" : ""), a.mod, { fill: key ? SOFT : [255, 255, 255], vc: key ? ACC : INK, vsize: 18 });
    });
    y += 54;
    const sw = (W - 2 * M - 7 * 6) / 8;
    C.stats.forEach(([l, v], i) => box(M + i * (sw + 6), y, sw, 44, l, v, { vsize: 15, fill: i < 2 ? [248, 242, 230] : [255, 255, 255] }));
    y += 56;

    // skills | strikes & gear
    const colW = (W - 2 * M - 16) / 2, xL = M, xR = M + colW + 16, top = y;
    const colHead = (label, x) => { font("bold", 9, ACC); text(label.toUpperCase(), x, y + 9, { charSpace: 0.8 }); color(ACC, "draw"); doc.setLineWidth(1.2); doc.line(x, y + 13, x + colW, y + 13); };
    colHead("Skills", xL);
    let yl = y + 24;
    const rowH = 13;
    [...C.skills, ...C.lores].forEach((s, i) => {
        if (i % 2 === 0) { color([246, 248, 250], "fill"); doc.rect(xL, yl - 9.5, colW, rowH, "F"); }
        font(s.rank === "U" ? "normal" : "bold", 8.5, s.rank === "U" ? MUTED : INK); text(s.name, xL + 4, yl);
        font("bold", 7.5, s.rank === "U" ? MUTED : ACC); text(s.rank, xL + colW - 40, yl, { align: "center" });
        font("bold", 8.5, INK); text(s.mod, xL + colW - 6, yl, { align: "right" });
        yl += rowH;
    });
    y = top; colHead("Strikes", xR);
    let yr = y + 24;
    if (!C.strikes.length) { font("normal", 8.5, MUTED); text("None", xR, yr); yr += rowH; }
    for (const s of C.strikes) {
        font("bold", 8.5, INK); text(s.name, xR, yr);
        font("bold", 8.5, ACC); text(s.attack, xR + colW - 90, yr, { align: "right" });
        font("normal", 8, INK); text(s.damage, xR + colW, yr, { align: "right" });
        yr += 11;
        if (s.traits) { font("normal", 7, MUTED); const t = doc.splitTextToSize(clean(s.traits), colW); text(t[0], xR, yr); yr += 10; }
        yr += 2;
    }
    yr += 8;
    font("bold", 9, ACC); text("GEAR", xR, yr + 9, { charSpace: 0.8 }); color(ACC, "draw"); doc.line(xR, yr + 13, xR + colW, yr + 13);
    yr += 24;
    for (const g of C.gear.slice(0, 22)) { font(g.worn ? "bold" : "normal", 8.5, INK); text(`${g.qty > 1 ? g.qty + " x " : ""}${g.name}${g.worn ? " (worn)" : ""}`, xR, yr); yr += 11.5; }
    if (C.gear.length > 22) { font("normal", 8, MUTED); text(`+ ${C.gear.length - 22} more`, xR, yr); yr += 11.5; }
    font("bold", 8.5, INK); text(`Credits: ${C.credits}`, xR, yr + 4); yr += 16;
    if (C.languages.length) { font("normal", 8, MUTED); const t = doc.splitTextToSize(clean(`Languages: ${C.languages.join(", ")}`), colW); for (const l of t) { text(l, xR, yr); yr += 10; } }
    y = Math.max(yl, yr) + 6;

    // feats
    heading("Feats");
    for (const f of C.feats) {
        need(12);
        font("bold", 7.5, ACC); text(`${f.level}`, M + 8, y + 8, { align: "center" });
        font("normal", 7.5, MUTED); text(f.type, M + 22, y + 8);
        font("bold", 8.5, INK); text(f.name + (f.extra ? ` (${f.extra})` : ""), M + 92, y + 8);
        y += 12;
    }
    heading("Class and ancestry features");
    para(C.features.map((f) => `${f.name}${f.level > 1 ? ` (${f.level})` : ""}`).join(", ") || "None");

    // spells
    for (const g of C.spellGroups) {
        if (!g.ranks.length) continue;
        heading(g.name + (g.dc ? `  -  DC ${g.dc}, attack ${g.attack}` : ""));
        for (const r of g.ranks) {
            need(12);
            font("bold", 8.5, ACC); text(r.rank === 0 ? "Cantrips" : g.focus ? "Focus spells" : `Rank ${r.rank}${r.slots ? ` (${r.slots}/day)` : ""}`, M, y + 8);
            const lines = doc.splitTextToSize(clean(r.list.join(", ")), W - 2 * M - 90);
            font("normal", 8.5, INK);
            for (const l of lines) { need(12); text(l, M + 90, y + 8); y += 12; }
        }
    }
    if (C.focus) { y += 4; para(`Focus Points: ${C.focus}`, M, W - 2 * M, 8.5, MUTED); }
    if (C.notes) { heading("Notes"); para(C.notes); }
    footer();
    return doc;
}

export async function downloadPDF(actor) {
    const C = await sheetData(actor);
    const doc = await buildPDF(C);
    doc.save(`${safeName(actor.name)}.pdf`);
    return doc;
}

/** Ask what to export, then do it. */
export async function exportDialog(actor) {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) return downloadJSON(actor);
    const choice = await DialogV2.wait({
        window: { title: `Export ${actor.name}`, icon: "fa-solid fa-file-export" },
        content: `<p>Save this character as a file.</p>
            <p><b>JSON</b> can be imported back into the Character Forge in any world, and works with Pathmuncher.<br><b>PDF</b> is a printable character sheet.</p>`,
        buttons: [
            { action: "json", label: "JSON file", icon: "fa-solid fa-file-code", default: true },
            { action: "pdf", label: "PDF sheet", icon: "fa-solid fa-file-pdf" },
        ],
        rejectClose: false,
    });
    try {
        if (choice === "json") downloadJSON(actor);
        else if (choice === "pdf") await downloadPDF(actor);
    } catch (err) {
        console.error(err);
        ui.notifications.error(`Couldn't export ${actor.name}: ${err.message}`);
    }
}
