# Suite UI preferences — theme and language on the account (SCRUM-653)

## What

A person's **theme** (`system` | `light` | `dark`) and **language** (`en` | `th`)
are kept on their platform account. Every staff app reads them after
sign-in and writes the theme back from its own toggle, so the choice follows
the person between the launcher, the till, the console, the inbox, Radar and
the OTO App, rather than resetting per app and on every reload.

- **Store:** `core.account.ui_theme` (default `system`) and
  `core.account.ui_language` (default `en`), each with a CHECK. Migration
  `0085_account_ui_preferences`, expand-only.
- **Read:** `GET /me` answers `preferences: { theme, language }`.
- **Write:** `PUT /me/preferences` — session auth, the caller's own account
  only (there is no id in the path). Body `{ theme?, language? }`, at least one,
  nothing else (strict). One transaction with an `account.preferences` audit
  row (`entityType: 'account'`, `before`/`after` = `{ theme, language }`).
  Answers `{ preferences: { theme, language } }`; a replayed `Idempotency-Key`
  gets the stored answer.
- **Rule, once:** `packages/shared/src/ui-preferences.ts` — the values, the
  body schema, `resolveTheme` (`system` maps to `prefers-color-scheme` at apply
  time), the toggle's cycle (light → dark → system → light), `readUiPreferences`
  for a `/me` answer, and `createThemeController`: a framework-free store that
  adopts the account's choice, paints `dark`/`light` on the document root,
  follows the device while the choice is `system`, and writes a signed-in
  toggle back fire-and-forget with one retry on the same replay key. It never
  touches browser storage.

## Where each app hooks in

| App | File | How |
| --- | --- | --- |
| Launcher (master wiring) | `apps/launcher/src/lib/accountTheme.ts` | The controller wired to `document`, `matchMedia` and `preferencesApi.put`. `SessionContext` adopts from `/me` and releases at sign-out; `App` starts it. `ThemeCycleButton` in the header and on the signed-out page cycles light → dark → system. |
| POS (staff side) | `apps/pos/src/lib/themePref.ts` | `staffThemeController`, the same wiring. `OperatorProvider.hydrate` adopts from `/me`; `logout` releases. The theme menu's Staff row cycles the three values. The staff-side `LanguageProvider` is set to the account language at sign-in. |
| Radar | `apps/radar/client/src/lib/platformTheme.ts`, `server/signOn.ts` | The identity read from `/me` carries `preferences`; `/api/me` answers it. The sign-in gate adopts it; the toggle writes through the new guarded `PUT /api/me/preferences`, which forwards with the person's own platform token. |
| OTO App | `apps/oto-app/client/src/lib/platformTheme.ts`, `server/middleware/platformSignOn.ts` | At the launcher hand-off the app reads `/me` once and keeps `preferences` in the server-side session; `/api/user` answers `platformPreferences`. `AuthProvider` adopts it; every layout's toggle writes through the new `PUT /api/platform/preferences`, which forwards with the sealed platform token. |
| Console | — | SCRUM-654 (below). |
| Inbox | — | The dark-theme lane (below). |

Radar and the OTO App are lifted with npm and cannot import `@oto/shared`, so
each holds a copy of the rule in `shared/uiPreferences.ts` whose header names
the master. Their own providers and toggles stay (two-state light/dark, as
designed); only adopting the account's choice and writing back are new.

## What stays per device, and why

- **The till's Display theme.** It belongs to the screen facing the customer,
  not to whoever is signed in at the till, so it stays in module memory per
  device and resets on reload, as before. The theme menu's note says which is
  which.
- **Before sign-in.** The launcher's signed-out page and the till's lock screen
  show light, as they always have; a toggle there repaints and writes nothing.
  After sign-out what is painted stays until the next person signs in.
- **Radar's and the OTO App's localStorage `theme`.** Kept as the fast-start
  cache for the first paint before `/api/me` or `/api/user` answers; the
  account's choice wins once it does.
- **An OTO App legacy-login session** (no launcher hand-off) has no suite
  account to write to: its toggle stays browser-only, and the proxy answers 409
  `not_platform_session` if called.
- **Customer-facing language.** `/display` (its own stored choice) and `/kiosk`
  (resets per guest) keep their own providers and toggles.

## Language: who consumes it

Stored and returned today; applied only where an app has staff-side language:

- **POS:** the staff-side `LanguageProvider` (the one in `StaffApp`) is set to
  the account language at sign-in. Note: in the split-screen harness that same
  provider also drives the till's on-screen customer display and `/book`, so a
  `th` account starts those in Thai; the customer's own switch still changes
  it.
- **Later:** the Console and the Inbox when they gain a staff-side Thai
  dictionary; the launcher's own words; the OTO App's `I18nProvider`
  (it already has one — adopting `platformPreferences.language` there is a
  small follow-up); Radar has none.

## Hand-offs

**Console (SCRUM-654, Codex).** Copy `apps/launcher/src/lib/accountTheme.ts`
over `apps/console/src/lib/theme.ts` (change only the import of its own
`preferencesApi`, which needs `api.put` and
`ApiResponse<'/me/preferences','put'>` from `@oto/api-types`), call
`accountTheme.adopt(me.preferences)` where the console reads `/me` and
`accountTheme.release()` at sign-out, `useEffect(() => accountTheme.start(), [])`
at the root, and reuse `ThemeCycleButton`'s markup for its toggle.

**Inbox (dark-theme lane).** Same copy as the Console. The Inbox's dark tokens
are the other lane's; this lane provides the hook and the `/me` field only.

Contracts both consume:

```
GET /me → { …, preferences: { theme: 'system'|'light'|'dark', language: 'en'|'th' } }
PUT /me/preferences  body { theme?: …, language?: … } (≥1, strict)
                     → 200 { preferences: { theme, language } }
                     → 400 VALIDATION · 401 · 409 IDEMPOTENCY_MISMATCH
```
