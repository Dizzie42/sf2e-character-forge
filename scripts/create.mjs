import { STARTING_CREDITS } from "./model.mjs";
import { applyLevel } from "./levels.mjs";

/** Answers the ChoiceSet hook should apply while the Forge is building an actor */
export const FORGE_RUN = { answers: null };

/**
 * Wrap the system's ChoiceSet rule element so that, while the Forge is creating an actor, choices the player
 * already made in the wizard are applied instead of prompting. Anything the wizard did not answer (or an answer
 * that isn't valid for the actor) falls through to the system's normal prompt.
 */
export function installChoiceSetHook() {
    const ChoiceSet = game.pf2e?.RuleElements?.builtin?.ChoiceSet;
    if (!ChoiceSet) {
        console.warn("Character Forge | ChoiceSet rule element not found; the system will prompt for every choice.");
        return;
    }
    if (ChoiceSet.prototype.__forgeWrapped) return;
    const original = ChoiceSet.prototype.preCreate;
    ChoiceSet.prototype.preCreate = async function forgePreCreate(args) {
        try {
            const answers = FORGE_RUN.answers;
            if (answers && (this.selection === null || this.selection === undefined)) {
                const slug = this.item?._source?.system?.slug ?? this.item?.system?.slug ?? game.pf2e.system.sluggify(this.item?.name ?? "");
                const key = `${slug}|${this.sourceIndex}`;
                if (key in answers) {
                    this.selection = answers[key];
                    if (args?.ruleSource) args.ruleSource.selection = answers[key];
                }
            }
        } catch (err) {
            console.warn("Character Forge | could not pre-answer a choice", err);
        }
        return original.call(this, args);
    };
    ChoiceSet.prototype.__forgeWrapped = true;
}

async function sourceOf(data, uuid) {
    const doc = await data.doc(uuid);
    if (!doc) throw new Error(`Could not load ${uuid}`);
    const src = game.items.fromCompendium(doc, { clearFolder: true });
    return src;
}

export async function createCharacter(data, S, D, { ownerId = null } = {}) {
    const ActorCls = CONFIG.Actor.documentClass;
    const name = S.name?.trim() || "New Character";

    // Free level-1 boosts and skill picks live on the actor; everything else comes from items
    const skills = {};
    for (const s of D.chosenSkills) skills[s] = { rank: 1 };
    const langs = S.langs.filter((l) => !D.langBase.includes(l));

    const actor = await ActorCls.create({
        name,
        type: "character",
        ...(ownerId && ownerId !== game.user.id ? { ownership: { default: 0, [ownerId]: 3 } } : {}),
        system: {
            details: {
                level: { value: 1 },
                age: { value: S.age ?? "" },
                gender: { value: S.gender ?? "" },
                languages: { value: langs },
                biography: { backstory: S.notes ? `<p>${foundry.utils.escapeHTML?.(S.notes) ?? S.notes}</p>` : "" },
            },
            build: { attributes: { boosts: { 1: S.free.slice(0, 4) } } },
            skills,
        },
    }, { renderSheet: false });
    if (!actor) return null;

    FORGE_RUN.answers = S.answers;
    try {
        const add = async (sources) => {
            const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
            if (!list.length) return [];
            return actor.createEmbeddedDocuments("Item", list);
        };

        /* Ancestry, with boost selections */
        if (D.anc) {
            const src = D.anc.custom ? D.anc.toSource() : await sourceOf(data, D.anc.uuid);
            if (S.alt) {
                src.system.alternateAncestryBoosts = S.altBoosts.slice(0, 2);
            } else {
                for (const [k, b] of Object.entries(src.system.boosts ?? {})) {
                    if ((b.value ?? []).length > 1 && S.ancSel[k]) b.selected = S.ancSel[k];
                }
            }
            await add(src);
        }
        if (D.her) await add(D.her.custom ? D.her.toSource() : await sourceOf(data, D.her.uuid));

        /* Background, with boost selections (its skill feat is granted by the system) */
        if (D.bg) {
            const src = D.bg.custom ? D.bg.toSource() : await sourceOf(data, D.bg.uuid);
            for (const [k, b] of Object.entries(src.system.boosts ?? {})) {
                if ((b.value ?? []).length > 1 && S.bgSel[k]) b.selected = S.bgSel[k];
            }
            await add(src);
        }

        /* Class (the system adds its 1st-level class features and runs their choices) */
        if (D.cls) {
            const src = await sourceOf(data, D.cls.uuid);
            if ((src.system.keyAbility?.value ?? []).length > 1 && D.key) src.system.keyAbility.selected = D.key;
            await add(src);
        }

        /* Feats in their 1st-level slots */
        if (S.feats.anc) {
            const src = await sourceOf(data, S.feats.anc);
            src.system.location = "ancestry-1";
            src.system.level = { ...(src.system.level ?? {}), taken: 1 };
            await add(src);
        }
        if (S.feats.cls && D.hasClassFeat) {
            const src = await sourceOf(data, S.feats.cls);
            src.system.location = "class-1";
            src.system.level = { ...(src.system.level ?? {}), taken: 1 };
            await add(src);
        }
        for (const uuid of S.extra) {
            const src = await sourceOf(data, uuid);
            src.system.location = null;
            await add(src);
        }

        /* Lore skills */
        const lores = D.lores.map((l) => ({ name: l, type: "lore", system: { proficient: { value: 1 }, mod: { value: 0 } } }));
        if (lores.length) await add(lores);

        /* Spellcasting */
        if (D.caster && D.tradition) {
            const trad = D.tradition;
            const tradLabel = trad.charAt(0).toUpperCase() + trad.slice(1);
            const [entry] = await add({
                name: `${tradLabel} Spontaneous Spells`,
                type: "spellcastingEntry",
                system: {
                    ability: { value: D.key || "wis" },
                    tradition: { value: trad },
                    prepared: { value: "spontaneous" },
                    proficiency: { value: 1 },
                    slots: { slot1: { max: 3, value: 3 } },
                },
            });
            const firsts = new Set([D.grantedFirst?.uuid, ...S.spells.first].filter(Boolean));
            const spellUuids = [D.grantedCantrip?.uuid, ...S.spells.cantrips, ...firsts].filter(Boolean);
            const spells = [];
            for (const uuid of [...new Set(spellUuids)]) {
                const src = await sourceOf(data, uuid);
                src.system.location = firsts.has(uuid) ? { value: entry.id, heightenedLevel: 1 } : { value: entry.id };
                spells.push(src);
            }
            if (spells.length) await add(spells);

            if (D.focusSpell) {
                const [focus] = await add({
                    name: `${tradLabel} Focus Spells`,
                    type: "spellcastingEntry",
                    system: { ability: { value: D.key || "wis" }, tradition: { value: trad }, prepared: { value: "focus" }, proficiency: { value: 1 }, slots: {} },
                });
                const src = await sourceOf(data, D.focusSpell.uuid);
                src.system.location = { value: focus.id };
                await add(src);
                await actor.update({ "system.resources.focus.value": 1 });
            }
        }

        /* Equipment */
        const gear = [];
        if (S.gear.armor) {
            const src = await sourceOf(data, S.gear.armor);
            src.system.equipped = { carryType: "worn", inSlot: true, handsHeld: 0 };
            gear.push(src);
        }
        if (S.gear.shield) gear.push(await sourceOf(data, S.gear.shield));
        for (const { uuid, q } of S.gear.weapons) {
            const src = await sourceOf(data, uuid);
            src.system.quantity = q;
            gear.push(src);
        }
        for (const { uuid, q } of S.gear.items) {
            const src = await sourceOf(data, uuid);
            src.system.quantity = q;
            gear.push(src);
        }
        if (gear.length) await add(gear);

        /* Remaining credits on a credstick */
        const credits = Math.max(0, Math.floor(D.credits ?? STARTING_CREDITS));
        if (credits > 0 && actor.inventory?.addCurrency) await actor.inventory.addCurrency({ credits });

        /* Start at full Hit Points */
        const max = actor.system.attributes?.hp?.max;
        if (typeof max === "number" && max > 0) await actor.update({ "system.attributes.hp.value": max });

        /* Make it the player's assigned character if they don't have one yet */
        const owner = ownerId ? game.users.get(ownerId) : null;
        if (owner && !owner.isGM && !owner.character) {
            try { await owner.update({ character: actor.id }); } catch (err) { console.warn("Character Forge | could not assign character", err); }
        }

    } finally {
        FORGE_RUN.answers = null;
    }

    /* Starting above 1st level: apply each level the same way the Level Up window does */
    const target = Math.min(S.imported ? 20 : 3, Math.max(1, Number(S.level) || 1));
    for (let L = 2; L <= target; L++) {
        const plan = S.levels?.[L];
        if (!plan) break;
        FORGE_RUN.answers = { ...S.answers };
        await applyLevel(data, actor, plan);
    }
    if (target > 1) {
        const max = actor.system.attributes?.hp?.max;
        if (typeof max === "number" && max > 0) await actor.update({ "system.attributes.hp.value": max });
    }
    return actor;
}

