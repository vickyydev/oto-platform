# imports/ — raw material from the existing OTO systems

Everything in here is **reference input**, not part of the build, and **not
versioned**: git ignores the whole folder except these README files. Nothing
under `imports/` is in the pnpm workspace, the linter, CI or any deployment.
Code is read here, then integrated into `apps/*` and `packages/*` deliberately.

## What goes where

| Folder | Put here |
|---|---|
| `imports/<app-name>/` | One Replit export per **real** app, unzipped as-is (e.g. `imports/oto-app/`, `imports/oto-radar/`). Keep Replit's own files (`.replit`, `replit.md`, `.agents/`) — they carry the app's design intent. |
| `imports/_db/` | The production **schema** file and **data dump(s)** of the existing Postgres. |
| `imports/_vendor-docs/` | Device and provider documents: card terminal integration specs, gate controller protocol, wristband and receipt printer command manuals, 2C2P documentation. |
| `imports/oto-pos/` | The original Oto POS Replit prototype that `apps/pos` was ported from. |

## Rules for a drop

1. **One folder per app, named after the app** in lowercase-with-dashes. Do not
   merge two apps into one folder. Mockup-only projects do not need importing.
2. **Do not run `npm install` / `pnpm install` inside an import** — no
   `node_modules` in here.
3. **Re-exports replace the same folder.** Record the export date in the app's
   page under `docs/features/` so it is clear which version was reviewed.

## After a drop

For each new app: read the code and its Replit notes, compare the app's own
schema files against the real production schema in `imports/_db/`, and write
an intake page under `docs/features/` from `_TEMPLATE.md`.
