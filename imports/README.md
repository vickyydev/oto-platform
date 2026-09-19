# imports/ — raw material from the existing OTO systems

Everything in here is **reference input**, not part of the build. Nothing under
`imports/` is in the pnpm workspace, the linter, CI or any deployment. Code is
read here, then integrated into `apps/*` and `packages/*` deliberately.

## What goes where

| Folder | Put here | Committed to git? |
|---|---|---|
| `imports/<app-name>/` | One Replit export per **real** app, unzipped as-is (e.g. `imports/oto-app/`, `imports/oto-radar/`). Keep Replit's own files (`.replit`, `replit.md`, `.agents/`) — they carry the app's design intent. | Yes (secrets excluded by `.gitignore`) |
| `imports/_db/` | The production **schema** file and **data dump(s)** of the existing Postgres. | **No — never.** Ignored by git except its README. |
| `imports/_vendor-docs/` | Device and provider documents: GHL LinkPOS spec, Digio Direct Terminal spec, gate controller protocol (GE-X2 / HX-X1), wristband + receipt printer command manuals, 2C2P docs / sandbox notes. | Yes, unless a document is marked confidential — then tell Claude and it stays local. |
| `imports/oto-pos/` | Already here: the original Oto POS Replit prototype this platform's POS was ported from. | Yes |

## Rules for a drop

1. **One folder per app, named after the app** in lowercase-with-dashes. Do not
   merge two apps into one folder. Mockup-only projects do not need importing.
2. **Do not run `npm install` / `pnpm install` inside an import** — no
   `node_modules` in here.
3. **Re-exports overwrite the same folder.** If the client changes an app in
   Replit later, export again into the same folder and commit; the git diff
   then shows exactly what changed since the last import.
4. Before committing an import, Claude scans it for secrets (`.env`, API keys,
   tokens in source) and records the app in `docs/features/`.

## After a drop

Tell Claude which folders are new. For each app it will: read the code and
Replit notes, diff the app's own schema files against the real production
schema in `imports/_db/`, and write an intake page under `docs/features/`.
