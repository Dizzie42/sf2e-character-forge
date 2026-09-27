/**
 * Data access for Character Forge.
 * Everything is read from the Item compendiums available in the world (the sf2e system packs plus any
 * homebrew/module packs), so the wizard always matches the installed system version.
 */

export const ATTRS = ["str", "dex", "con", "int", "wis", "cha"];
export const ATTR_LABEL = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };

export function sluggify(text, camel = null) {
    const fn = globalThis.game?.pf2e?.system?.sluggify;
    if (fn) return fn(text, camel ? { camel } : {});
    if (typeof text !== "string") return "";
    if (camel === "dromedary") {
        return text.replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/[-_]+/g, " ")
            .replace(/(?:^\w|[A-Z]|\b\w)/g, (p, i) => (i === 0 ? p.toLowerCase() : p.toUpperCase())).replace(/\s+/g, "");
    }
    return text.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/['’]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/[-\s]+/g, "-");
}

export function localize(key) {
    if (typeof key !== "string") return String(key ?? "");
    const out = game.i18n?.localize(key) ?? key;
    if (out !== key) return out;
    // Unlocalized system keys: show the last segment as words rather than a raw key
    if (/^(PF2E|SF2E)\./.test(key)) return key.split(".").pop().replace(/([a-z])([A-Z])/g, "$1 $2");
    return key;
}

/** Plain-text summary of an HTML description, with @UUID links reduced to their labels */
export function plainText(html, max = 0) {
    let s = String(html ?? "")
        .replace(/@UUID\[[^\]]*?\.([^.\]]+)\]\{([^}]*)\}/g, "$2")
        .replace(/@UUID\[[^\]]*?\.([^.\]]+)\]/g, "$1")
        .replace(/@(Check|Damage|Template|Localize)\[([^\]]*)\](\{([^}]*)\})?/g, (m, t, a, b, label) => label || a.split("|")[0])
        .replace(/\[\[\/[^\]]*\]\](\{([^}]*)\})?/g, (m, b, label) => label || "")
        .replace(/<\/(p|li|h\d)>/g, "\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    if (max && s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "…";
    return s;
}

/** Credits value of a PF2e/SF2e price object ({value:{credits, sp, gp, pp, cp}, per}) */
export function priceCredits(price) {
    const v = price?.value ?? {};
    const total = (v.credits ?? 0) + (v.sp ?? 0) + 10 * (v.gp ?? 0) + 100 * (v.pp ?? 0) + (v.cp ?? 0) / 10;
    return Math.round(total * 10) / 10 / Math.max(1, price?.per ?? 1);
}

export function bulkValue(bulk) {
    const v = bulk?.value ?? 0;
    return typeof v === "number" ? v : v === "L" ? 0.1 : parseFloat(v) || 0;
}

const INDEX_FIELDS = [
    "system.maxTakable",
    "system.slug", "system.level.value", "system.category", "system.traits.value", "system.traits.rarity",
    "system.traits.otherTags", "system.traits.traditions", "system.prerequisites.value", "system.publication.title",
    "system.actionType.value", "system.actions.value", "system.ritual", "system.price", "system.bulk", "system.damage",
    "system.range", "system.group", "system.acBonus", "system.dexCap", "system.strength", "system.checkPenalty",
    "system.speedPenalty", "system.hardness", "system.hp", "system.usage", "system.grade", "system.ancestry",
    "system.baseItem"
];

export class ForgeData {
    constructor() {
        this.ready = false;
        this.docCache = new Map();
    }

    async load(progress = () => {}) {
        let showPF = true;
        try { showPF = game.settings.get("sf2e-character-forge", "pathfinderHeritages") !== false; } catch (e) { /* ignore */ }
        const packs = game.packs.filter((p) => p.documentName === "Item" && (p.visible ?? true) && (showPF || p.collection !== "sf2e-character-forge.pathfinder-heritages"));
        // system packs first so their entries win name collisions
        packs.sort((a, b) => (b.metadata.packageName === game.system.id) - (a.metadata.packageName === game.system.id));
        this.packs = packs;
        const index = [];
        let n = 0;
        for (const pack of packs) {
            progress(`Indexing ${pack.metadata.label}…`, n++ / packs.length);
            try {
                const idx = await pack.getIndex({ fields: INDEX_FIELDS });
                for (const e of idx) index.push({ ...e, pack: pack.collection, packLabel: pack.metadata.label, uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}` });
            } catch (err) {
                console.warn("Character Forge | could not index", pack.collection, err);
            }
        }
        this.index = index;
        this.byUuid = new Map(index.map((e) => [e.uuid, e]));

        progress("Loading ancestries, heritages, backgrounds and classes…", 0.9);
        const abcTypes = new Set(["ancestry", "heritage", "background", "class"]);
        const abc = await this.#loadFull(index.filter((e) => abcTypes.has(e.type)));
        this.ancestries = abc.filter((d) => d.type === "ancestry").sort(byName);
        this.heritages = abc.filter((d) => d.type === "heritage").sort(byName);
        this.backgrounds = abc.filter((d) => d.type === "background").sort(byName);
        this.classes = abc.filter((d) => d.type === "class").sort(byName);

        this.feats = index.filter((e) => e.type === "feat").sort(byName);
        this.spells = index.filter((e) => e.type === "spell" && !e.system?.ritual).sort(byName);
        this.equipment = index.filter((e) => ["weapon", "armor", "shield", "equipment", "consumable", "ammo", "backpack"].includes(e.type)).sort(byName);
        this.languages = Object.entries(CONFIG.PF2E?.languages ?? {}).map(([slug, label]) => ({ slug, label: localize(label) }))
            .sort((a, b) => a.label.localeCompare(b.label));
        this.skills = Object.entries(CONFIG.PF2E?.skills ?? {}).map(([slug, s]) => ({
            slug, label: localize(typeof s === "string" ? s : s.label), attribute: (typeof s === "object" && s.attribute) || SKILL_ATTR[slug] || "int",
        })).sort((a, b) => a.label.localeCompare(b.label));
        this.ready = true;
        progress("Ready", 1);
    }

    async #loadFull(entries) {
        const byPack = new Map();
        for (const e of entries) {
            if (!byPack.has(e.pack)) byPack.set(e.pack, []);
            byPack.get(e.pack).push(e);
        }
        const out = [];
        for (const [collection, list] of byPack) {
            const pack = game.packs.get(collection);
            const size = pack.index.size;
            let docs;
            if (list.length > size * 0.5) {
                const ids = new Set(list.map((e) => e._id));
                docs = (await pack.getDocuments()).filter((d) => ids.has(d.id));
            } else {
                docs = await Promise.all(list.map((e) => pack.getDocument(e._id)));
            }
            for (const d of docs) if (d) { this.docCache.set(d.uuid, d); out.push(d); }
        }
        return out;
    }

    /** Load a full document by UUID (cached). Accepts id-based or name-based compendium UUIDs. */
    async doc(uuid) {
        if (!uuid) return null;
        if (this.docCache.has(uuid)) return this.docCache.get(uuid);
        let d = null;
        try { d = await fromUuid(uuid); } catch (err) { d = null; }
        if (!d) {
            // Name-based UUID (e.g. from an unbuilt description link): look up by name in that pack
            const m = /^Compendium\.([^.]+\.[^.]+)\.Item\.(.+)$/.exec(uuid);
            if (m) {
                const entry = this.index.find((e) => e.pack === m[1] && (e._id === m[2] || e.name === m[2]))
                    ?? this.index.find((e) => e.name === m[2]);
                if (entry) d = await game.packs.get(entry.pack).getDocument(entry._id);
            }
        }
        if (d) { this.docCache.set(uuid, d); this.docCache.set(d.uuid, d); }
        return d;
    }

    entry(uuid) { return this.byUuid.get(uuid) ?? null; }

    /** Evaluate a ChoiceSet compendium filter against the index. Returns null when the filter can't be evaluated here. */
    queryFilter(choices) {
        const filter = choices?.filter;
        if (!Array.isArray(filter) || JSON.stringify(filter).includes("{")) return null;
        const type = choices.itemType ?? "feat";
        const test = (e, p) => {
            if (typeof p === "string") {
                const m = /^item:(level|category|trait|tag|slug|type|rarity):(.+)$/.exec(p);
                if (!m) throw new Error("unsupported");
                const [, k, v] = m, s = e.system ?? {};
                switch (k) {
                    case "level": return (s.level?.value ?? 0) === Number(v);
                    case "category": return s.category === v;
                    case "trait": return (s.traits?.value ?? []).includes(v);
                    case "tag": return (s.traits?.otherTags ?? []).includes(v);
                    case "slug": return (s.slug ?? sluggify(e.name)) === v;
                    case "type": return e.type === v;
                    case "rarity": return (s.traits?.rarity ?? "common") === v;
                }
            }
            if (p && typeof p === "object") {
                if ("not" in p) return !test(e, p.not);
                if ("or" in p) return p.or.some((q) => test(e, q));
                if ("and" in p) return p.and.every((q) => test(e, q));
                for (const op of ["lte", "gte", "lt", "gt", "eq"]) {
                    if (op in p && p[op][0] === "item:level") {
                        const lv = e.system?.level?.value ?? 0, n = Number(p[op][1]);
                        return { lte: lv <= n, gte: lv >= n, lt: lv < n, gt: lv > n, eq: lv === n }[op];
                    }
                }
            }
            throw new Error("unsupported");
        };
        try {
            const seen = new Set();
            return this.index.filter((e) => e.type === type && filter.every((p) => test(e, p)))
                .filter((e) => { const k = (e.system?.slug ?? sluggify(e.name)); if (seen.has(k)) return false; seen.add(k); return true; })
                .map((e) => ({ value: choices.slugsAsValues ? (e.system?.slug ?? sluggify(e.name)) : e.uuid, label: e.name, uuid: e.uuid, rarity: e.system?.traits?.rarity }));
        } catch (err) {
            return null;
        }
    }
}

const SKILL_ATTR = {
    acrobatics: "dex", arcana: "int", athletics: "str", computers: "int", crafting: "int", deception: "cha", diplomacy: "cha",
    intimidation: "cha", medicine: "wis", nature: "wis", occultism: "int", performance: "cha", piloting: "dex", religion: "wis",
    society: "int", stealth: "dex", survival: "wis", thievery: "dex",
};

function byName(a, b) { return a.name.localeCompare(b.name); }

/* ------------------------------------------------------------------------------------------------
 * Choice tree: every ChoiceSet the build will hit, so the wizard can pre-answer them.
 * Keys are "<item slug>|<rule index>", matching what the runtime hook sees in ChoiceSet#preCreate.
 * ---------------------------------------------------------------------------------------------- */
function promptText(rule, flag) {
    const raw = rule.prompt ? game.i18n?.localize(rule.prompt) : null;
    if (raw && raw !== rule.prompt) return raw;
    const words = String(flag || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return words ? `Choose ${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}` : "Make a choice";
}

export async function buildChoiceTree(data, roots, answers) {
    const nodes = [];
    const visited = [];
    const seen = new Set();

    async function walk(doc, section, depth, via) {
        if (!doc || depth > 4) return;
        const slug = doc.system?.slug ?? sluggify(doc.name);
        const visitKey = `${doc.uuid}|${section}`;
        if (seen.has(visitKey)) return;
        seen.add(visitKey);
        const rules = doc.system?.rules ?? [];
        const flags = {};
        visited.push({ doc, section, via, flags });
        for (const [i, rule] of rules.entries()) {
            if (rule.key !== "ChoiceSet") continue;
            const key = `${slug}|${i}`;
            const flag = typeof rule.flag === "string" && rule.flag ? rule.flag : sluggify(slug, "dromedary");
            let options = null;
            const c = rule.choices;
            if (Array.isArray(c)) {
                options = c.map((o) => (typeof o === "object" && o !== null
                    ? { value: o.value, label: localize(o.label ?? (typeof o.value === "string" ? (data.entry(o.value)?.name ?? o.value.split(".").pop()) : String(o.value))), uuid: typeof o.value === "string" && o.value.startsWith("Compendium.") ? o.value : null }
                    : { value: o, label: String(o) }));
            } else if (c && typeof c === "object" && c.config === "skills") {
                options = data.skills.map((s) => ({ value: s.slug, label: s.label }));
            } else if (c && typeof c === "object" && "filter" in c) {
                options = data.queryFilter(c);
            }
            const answer = answers[key];
            nodes.push({ key, section, depth, via, itemName: doc.name, itemUuid: doc.uuid, flag, prompt: promptText(rule, flag), options, answer: answer ?? null });
            if (answer !== undefined && answer !== null) flags[flag] = answer;
            if (typeof answer === "string" && /^Compendium\./.test(answer)) {
                const child = await data.doc(answer);
                await walk(child, section, depth + 1, doc.name);
            }
        }
        for (const rule of rules) {
            if (rule.key === "GrantItem" && typeof rule.uuid === "string" && /^Compendium\./.test(rule.uuid) && !rule.uuid.includes("{")) {
                const child = await data.doc(rule.uuid);
                if (child && child.type === "feat") await walk(child, section, depth + 1, doc.name);
            }
        }
    }

    for (const { doc, section } of roots) await walk(doc, section, 0, null);
    return { nodes, visited };
}

/** Skills a set of visited documents train through ActiveEffectLike rules (resolving ChoiceSet selections). */
export function skillsFromRules(visited) {
    const out = [];
    for (const { doc, flags } of visited) {
        for (const rule of doc.system?.rules ?? []) {
            if (rule.key !== "ActiveEffectLike" || typeof rule.path !== "string") continue;
            let path = rule.path.replace(/\{item\|flags\.(?:system|pf2e|sf2e)\.rulesSelections\.([^}]+)\}/g, (m, f) => flags[f] ?? "?");
            const m = /^system\.skills\.([a-z-]+)\.rank$/.exec(path);
            if (!m || m[1] === "?") continue;
            if (!["upgrade", "override"].includes(rule.mode)) continue;
            if (rule.predicate && rule.predicate.length) continue;
            out.push({ skill: m[1], source: doc.name });
        }
    }
    return out;
}

/** The spell tradition set by a mystic connection or witchwarper paradox (flags.system.<class>.tradition). */
export function traditionFromRules(visited) {
    for (const { doc } of visited) {
        for (const rule of doc.system?.rules ?? []) {
            if (rule.key === "ActiveEffectLike" && /^flags\.(system|pf2e|sf2e)\.[a-z]+\.tradition$/.test(rule.path ?? "")) return rule.value;
        }
    }
    return null;
}

/** Granted spells listed in a connection/paradox description: cantrip, 1st rank and the initial focus spell. */
export function grantedSpells(doc) {
    const html = doc?.system?.description?.value ?? "";
    const pick = (re) => { const m = re.exec(html); return m ? m[1] : null; };
    return {
        cantrip: pick(/cantrip:\s*@UUID\[([^\]]+)\]/i),
        first: pick(/1st:\s*@UUID\[([^\]]+)\]/i),
        focus: pick(/initial:\s*@UUID\[([^\]]+)\]/i),
    };
}
