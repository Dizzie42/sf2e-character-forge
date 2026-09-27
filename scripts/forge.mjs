import { CharacterForgeApp, sharedData } from "./app.mjs";
import { installChoiceSetHook } from "./create.mjs";
import { registerRelay } from "./relay.mjs";
import { openLevelUp } from "./levelup.mjs";
import { registerTextSize } from "./textsize.mjs";
import { downloadJSON, downloadPDF, exportBuild, exportDialog } from "./export.mjs";

const MODULE_ID = "sf2e-character-forge";
let app = null;

function openForge() {
    if (!app || app.state === foundry.applications.api.ApplicationV2.RENDER_STATES.CLOSED) app = new CharacterForgeApp();
    app.render({ force: true });
    return app;
}

Hooks.once("init", () => {
    registerTextSize();
    game.settings.register(MODULE_ID, "pathfinderHeritages", {
        name: "SF2EFORGE.Settings.PathfinderHeritages.Name",
        hint: "SF2EFORGE.Settings.PathfinderHeritages.Hint",
        scope: "world", config: true, type: Boolean, default: true,
    });
    game.settings.register(MODULE_ID, "allowHomebrew", {
        name: "SF2EFORGE.Settings.Homebrew.Name",
        hint: "SF2EFORGE.Settings.Homebrew.Hint",
        scope: "world", config: true, type: Boolean, default: true,
        onChange: () => { for (const a of foundry.applications.instances?.values?.() ?? []) if (a.element?.classList?.contains("sf2e-forge")) a.render(); },
    });
    game.modules.get(MODULE_ID).api = {
        open: openForge,
        levelUp: openLevelUp,
        /** Open the Forge and import Pathbuilder/Hephaistos JSON (an object or a JSON string) */
        importCharacter: async (json) => { const f = openForge(); await f.importFrom(json); return f; },
        /** Pathbuilder-format JSON for an actor */
        exportJSON: (actor) => exportBuild(actor),
        downloadJSON, downloadPDF, exportDialog,
        data: sharedData,
    };
});

Hooks.once("ready", () => {
    if (game.system.id !== "sf2e") {
        console.warn("Character Forge | This module needs the Starfinder Second Edition (sf2e) system. It won't run in this world.");
        return;
    }
    registerPathfinderTraits();
    installChoiceSetHook();
    registerRelay();
});

/** "Character Forge" button in the Actors sidebar */
Hooks.on("renderActorDirectory", (directory, html) => {
    if (game.system.id !== "sf2e") return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector(".sf2e-forge-open")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sf2e-forge-open";
    btn.innerHTML = `<i class="fa-solid fa-user-astronaut"></i> ${game.i18n.localize("SF2EFORGE.Button.Open")}`;
    btn.addEventListener("click", (ev) => { ev.preventDefault(); openForge(); });
    const actions = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
    if (actions) actions.append(btn);
    else root.prepend(btn);
});

/** Right-click a character in the Actors sidebar: Export */
function addExportContext(entries) {
    if (!Array.isArray(entries) || entries.some((e) => e.name === "SF2EFORGE.Button.Export")) return;
    entries.push({
        name: "SF2EFORGE.Button.Export",
        icon: '<i class="fa-solid fa-file-export"></i>',
        condition: (li) => { const el = li instanceof HTMLElement ? li : li?.[0]; const a = game.actors?.get(el?.dataset?.entryId ?? el?.dataset?.documentId); return exportAllowed(a); },
        callback: (li) => { const el = li instanceof HTMLElement ? li : li?.[0]; const a = game.actors?.get(el?.dataset?.entryId ?? el?.dataset?.documentId); if (a) exportDialog(a); },
    });
}
Hooks.on("getActorContextOptions", (app, entries) => addExportContext(entries));
Hooks.on("getActorDirectoryEntryContext", (html, entries) => addExportContext(entries));

/* ---------------- Level Up button on character sheets ---------------- */
function xpReady(actor) {
    const xp = actor?.system?.details?.xp;
    return !!xp && typeof xp.value === "number" && xp.value >= (xp.max ?? 1000);
}
function exportAllowed(actor) {
    return game.system.id === "sf2e" && actor?.type === "character" && actor.isOwner;
}
function levelUpAllowed(actor) {
    return game.system.id === "sf2e" && actor?.type === "character" && actor.isOwner && (actor.level ?? actor.system?.details?.level?.value ?? 20) < 20;
}

// Application V1 sheets (SF2e on Foundry v13)
Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet.actor;
    if (exportAllowed(actor)) buttons.unshift({ label: game.i18n.localize("SF2EFORGE.Button.Export"), class: "sf2e-forge-export", icon: "fa-solid fa-file-export", onclick: () => exportDialog(actor) });
    if (!levelUpAllowed(actor)) return;
    buttons.unshift({ label: game.i18n.localize("SF2EFORGE.Button.LevelUp"), class: "sf2e-forge-levelup", icon: "fa-solid fa-circle-up", onclick: () => openLevelUp(actor) });
});
// Application V2 sheets (newer system versions)
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
    const actor = app.actor ?? app.document;
    if (exportAllowed(actor)) controls.push({ icon: "fa-solid fa-file-export", label: game.i18n.localize("SF2EFORGE.Button.Export"), action: "sf2eForgeExport", onClick: () => exportDialog(actor) });
    if (!levelUpAllowed(actor)) return;
    controls.unshift({ icon: "fa-solid fa-circle-up", label: game.i18n.localize("SF2EFORGE.Button.LevelUp"), action: "sf2eForgeLevelUp", onClick: () => openLevelUp(actor) });
});
function markReady(app, html) {
    const actor = app.actor ?? app.document;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const el = (app.element instanceof HTMLElement ? app.element : app.element?.[0]) ?? root;
    if (!el || actor?.type !== "character") return;
    const btn = el.querySelector(".sf2e-forge-levelup, [data-action='sf2eForgeLevelUp']");
    if (btn) { btn.classList.add("sf2e-forge-levelup"); btn.classList.toggle("xp-ready", xpReady(actor)); btn.title = xpReady(actor) ? "Enough XP to level up" : "Level up this character"; }
}
Hooks.on("renderActorSheet", markReady);
Hooks.on("renderActorSheetV2", markReady);

/* Make sure the Pathfinder heritage traits exist in this system's trait lists */
function registerPathfinderTraits() {
    const traits = { nephilim: "Nephilim", changeling: "Changeling", aiuvarin: "Aiuvarin", dromaar: "Dromaar", dhampir: "Dhampir", dragonblood: "Dragonblood", duskwalker: "Duskwalker", ardande: "Ardande", talos: "Talos", oni: "Oni", hungerseed: "Hungerseed", reflection: "Reflection", lineage: "Lineage" };
    for (const key of ["ancestryTraits", "creatureTraits", "featTraits"]) {
        const cfg = CONFIG.PF2E?.[key];
        if (!cfg) continue;
        for (const [slug, label] of Object.entries(traits)) if (!(slug in cfg)) cfg[slug] = label;
    }
}
