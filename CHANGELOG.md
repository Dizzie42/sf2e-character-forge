# Changelog

## 1.0.3

- Import now fills in "choose a feat" prompts from the imported file, such as the skill feat an operative's Striker specialization grants. Feats already placed in a slot aren't reused, and a prompt that asks for a specific kind of feat ("Select a skill feat") gets matched first.
- Choice prompts are only left for creation when the file doesn't say what was picked.

## 1.0.2

- Fixed import dropping extra 1st-level feats (bonus ancestry, skill and general feats, such as from Ancestry Paragon). They now land in Bonus Feats.
- Import now brings in armor and weapon upgrades (like a Force Field on Hardlight Series armor) and installs them, along with the item's grade.
- Export includes installed upgrades, so they survive a round trip.
- Imported high-level armor now shows correctly on the Gear step.
- Choice dropdowns (skill feats, specializations, weapon groups and so on) are now alphabetical, and so are the equipment groups and creature types.
- After you make a choice, its description now stays open, so you can compare options as you switch between them.

## 1.0.0 - First public release

- Step-by-step character creation for Starfinder 2e: ancestry, heritage, background, class, attribute boosts, skills, feats, spells, gear and details.
- Start new characters at level 1, 2 or 3.
- Import characters from Hephaistos 2E (its Pathmuncher JSON export), or any Pathbuilder-style JSON, at any level from 1 to 20. The Forge fills in every step for you to check before creating.
- Export any character as JSON (re-importable into the Forge, works with Pathmuncher) or as a printable PDF sheet, from the sheet header or the Actors sidebar.
- Level Up button on character sheets. It glows when the character has enough XP, walks you through everything the new level gives you, and can undo the last level up.
- Players can build characters without needing permission to create actors. The GM's client creates the actor and gives the player ownership.
- Choice prompts (such as skills and weapon groups) are answered inside the Forge instead of popping up afterwards.
- Feat prerequisite checks with color coding. Feats you don't qualify for are hidden by default.
- Expandable feat descriptions in every feat list.
- Mixed heritages (Player Core pg. 83), plus optional homebrew ancestries and backgrounds that the GM can turn off.
- Works with Pathfinder Anachronism: Pathfinder ancestries, classes and feats show up in the Forge when that module is on.
- Text size control (A−/A+) for the Forge windows.
- Drafts are saved between sessions.

## 1.0.1

   - Verified on Foundry v14 with the current Starfinder 2e system.