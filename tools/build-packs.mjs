// Compiles the JSON item sources in src/packs/* into Foundry LevelDB compendiums in packs/*.
// Usage: npm install && npm run build:packs
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readdir, rm } from "node:fs/promises";

for (const name of await readdir("src/packs")) {
    await rm(`packs/${name}`, { recursive: true, force: true });
    await compilePack(`src/packs/${name}`, `packs/${name}`, { log: true });
    console.log(`Built packs/${name}`);
}
