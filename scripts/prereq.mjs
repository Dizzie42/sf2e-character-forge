/**
 * Prerequisite checking for feat lists.
 * Each prerequisite line is classified as met, unmet or unknown (text we can't check automatically).
 * A feat is "unmet" if any line is definitely unmet, "unknown" if some line couldn't be checked, else "met".
 */
const RANKS = { trained: 1, expert: 2, master: 3, legendary: 4 };
const ATTR = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const SUBCLASS = /^(.+?) (paradox|connection|specialization|fighting style|leadership style|anchor)$/;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const base = (s) => norm(s).replace(/\s*\(.*\)\s*$/, "");

/** Names the whole data set knows about, so an unowned-but-real feat/feature counts as "unmet" rather than "unknown". */
export function knownNames(data) {
    if (data._knownNames) return data._knownNames;
    const s = new Set();
    for (const e of data.index ?? []) if (["feat", "heritage", "ancestry", "class", "background", "action"].includes(e.type)) { s.add(norm(e.name)); s.add(base(e.name)); }
    return (data._knownNames = s);
}

/**
 * Build the qualification snapshot.
 * q = { ranks: {slug: 0-4}, lores: [{name, rank}], mods: {str..}, level, names: iterable of owned item names, vision }
 */
export function qualifier(data, q) {
    const owned = new Set();
    for (const n of q.names ?? []) { if (!n) continue; owned.add(norm(n)); owned.add(base(n)); }
    const skillBy = new Map(data.skills.map((s) => [norm(s.label), s.slug]));
    const known = knownNames(data);

    const rankOf = (target) => {
        const t = norm(target).replace(/^the /, "");
        if (skillBy.has(t)) return q.ranks?.[skillBy.get(t)] ?? 0;
        if (/lore$/.test(t)) { const l = (q.lores ?? []).find((x) => norm(x.name) === t); return l ? l.rank : 0; }
        if (/^(a|any|at least one) skill$/.test(t)) return Math.max(0, ...Object.values(q.ranks ?? {}));
        return null; // perception, weapons, etc.
    };

    function checkPart(raw) {
        let s = norm(raw).replace(/\.$/, "");
        if (!s) return "met";
        // skill ranks: "trained in Arcana, Nature, Occultism, or Religion"
        let m = /^(?:at least )?(trained|expert|master|legendary) in (.+)$/.exec(s);
        if (m) {
            const need = RANKS[m[1]];
            const targets = m[2].split(/,\s*(?:or\s+)?|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
            let unknown = false;
            for (const t of targets) { const r = rankOf(t); if (r === null) unknown = true; else if (r >= need) return "met"; }
            return unknown ? "unknown" : "unmet";
        }
        // attributes: "Wisdom +2"
        m = /^(strength|dexterity|constitution|intelligence|wisdom|charisma) \+?(\d)/.exec(s);
        if (m) return (q.mods?.[ATTR[m[1]]] ?? 0) >= Number(m[2]) ? "met" : "unmet";
        // level
        m = /^(\d+)(?:st|nd|rd|th) level$/.exec(s);
        if (m) return (q.level ?? 1) >= Number(m[1]) ? "met" : "unmet";
        // senses
        if (s === "low-light vision") return ["low-light-vision", "darkvision"].includes(q.vision) || owned.has("low-light vision") ? "met" : "unknown";
        if (s === "darkvision") return q.vision === "darkvision" || owned.has("darkvision") ? "met" : "unknown";
        // "X heritage", "X paradox", etc.
        m = /^(.+?) heritage$/.exec(s);
        if (m) {
            const opts = m[1].split(/\s+or\s+/);
            if (opts.some((o) => owned.has(o) || owned.has(`${o} heritage`) || [...owned].some((n) => n.startsWith(o)))) return "met";
            return "unmet";
        }
        m = SUBCLASS.exec(s);
        if (m) return owned.has(m[1]) ? "met" : known.has(m[1]) ? "unmet" : "unknown";
        // one or more names: "Compact Predator, Puff Up, or Squirt Blood"
        const names = s.split(/,\s*(?:or\s+)?|\s+or\s+/).map((x) => x.replace(/^the /, "").replace(/ (feat|class feature|feature)$/, "").trim()).filter(Boolean);
        if (names.some((n) => owned.has(n) || owned.has(base(n)))) return "met";
        if (names.every((n) => known.has(n) || known.has(base(n)))) return "unmet";
        return "unknown";
    }

    return function check(entry) {
        const pre = (entry?.system?.prerequisites?.value ?? []).map((p) => (typeof p === "string" ? p : p?.value)).filter(Boolean);
        if (!pre.length) return { status: "none", unmet: [], unknown: [], text: "" };
        const unmet = [], unknown = [];
        for (const p of pre) {
            const r = checkPart(p);
            if (r === "unmet") unmet.push(p); else if (r === "unknown") unknown.push(p);
        }
        return { status: unmet.length ? "unmet" : unknown.length ? "unknown" : "met", unmet, unknown, text: pre.join("; ") };
    };
}

/** Owned names from the creator's derived state (level 1) */
export function creatorNames(D) {
    const docs = [D.anc, D.her, D.bg, D.cls, ...(D.features ?? []), D.featAnc, D.featCls, ...(D.extraFeats ?? []), ...(D.visited ?? []).map((v) => v.doc)];
    return docs.filter(Boolean).map((d) => d.name);
}
