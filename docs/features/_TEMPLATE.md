# <App name>

## What it is for
One paragraph: who uses it, for what, how often.

## Intake (filled when the export is first reviewed)
- **Source:** `imports/<app-name>/` — export date, Replit project name
- **Real or mockup:** live with production data / prototype on sample data
- **Stack:** frontend, backend, ORM, auth method, file storage, third-party services
- **Its tables:** which tables in the production schema belong to this app
- **Export vs production:** differences found between the app's own schema files and the real production schema (`imports/_db/`)
- **Shared entities it touches:** branches, staff/users, customers, children, …
- **Replit-specific dependencies to replace:** auth, database, object storage, secrets, AI integrations
- **Secrets found in the export:** (none / list — and confirm they were excluded from git)

## Integration plan
- Deployable(s): frontend site, backend service
- Login: how its sign-in is replaced by the platform's
- Data: its schema in the central database; links to shared entities; what the post-import script must do for this app
- Launcher tile: name, icon, permission that shows it

## Status
| Area | State | Notes |
|---|---|---|
|  | not started / in progress / done / mock |  |

## Open questions
