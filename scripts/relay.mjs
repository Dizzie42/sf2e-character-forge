/**
 * Lets players without the "Create New Actors" permission use the Forge:
 * the player's client sends the finished build to the active GM, whose client creates the actor
 * and gives the player ownership.
 */
import { sharedData } from "./app.mjs";
import { derive } from "./model.mjs";
import { createCharacter } from "./create.mjs";

const CHANNEL = "module.sf2e-character-forge";
const pending = new Map();

export function canCreateLocally() {
    return game.user.isGM || game.user.can("ACTOR_CREATE");
}

export function gmOnline() {
    return !!(game.users.activeGM ?? game.users.find((u) => u.isGM && u.active));
}

function isResponsibleGM() {
    const gm = game.users.activeGM ?? game.users.filter((u) => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0];
    return !!gm && gm.id === game.user.id;
}

/** Player side: ask the GM to build the character. Resolves with the new actor. */
export function requestGMCreate(state) {
    if (!gmOnline()) return Promise.reject(new Error("No GM is logged in"));
    const requestId = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Your GM's Foundry didn't answer in time. Is the GM still logged in?")); }, 10 * 60 * 1000);
        pending.set(requestId, { resolve, reject, timer });
        game.socket.emit(CHANNEL, { type: "create", requestId, userId: game.user.id, state });
        ui.notifications.info("Sent to your GM to build…");
    });
}

async function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // Player side: answer from the GM
    if ((msg.type === "created" || msg.type === "failed") && msg.userId === game.user.id) {
        const p = pending.get(msg.requestId);
        if (!p) return;
        pending.delete(msg.requestId);
        clearTimeout(p.timer);
        if (msg.type === "failed") return p.reject(new Error(msg.message || "Your GM's Foundry couldn't build the character"));
        // The actor may take a moment to arrive with ownership
        let actor = game.actors.get(msg.actorId);
        for (let i = 0; !actor && i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); actor = game.actors.get(msg.actorId); }
        return actor ? p.resolve(actor) : p.reject(new Error("The character was created but isn't visible to you yet. Ask your GM to check its ownership."));
    }

    // GM side: build it
    if (msg.type === "create" && game.user.isGM && isResponsibleGM()) {
        const player = game.users.get(msg.userId);
        const who = player?.name ?? "A player";
        ui.notifications.info(`Building ${msg.state?.name || "a character"} for ${who}…`);
        try {
            const data = sharedData();
            if (!data.ready) await data.load();
            const D = await derive(data, msg.state);
            const actor = await createCharacter(data, msg.state, D, { ownerId: msg.userId });
            game.socket.emit(CHANNEL, { type: "created", requestId: msg.requestId, userId: msg.userId, actorId: actor.id });
            ui.notifications.info(`${actor.name} is ready for ${who}.`);
        } catch (err) {
            console.error("Character Forge | GM-side creation failed", err);
            game.socket.emit(CHANNEL, { type: "failed", requestId: msg.requestId, userId: msg.userId, message: err.message });
            ui.notifications.error(`Couldn't build ${who}'s character: ${err.message}.`);
        }
    }
}

export function registerRelay() {
    game.socket.on(CHANNEL, onMessage);
}
