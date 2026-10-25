# SCRUM-634 — Staff and HR summary preparation

The approved P3-6 adds on-shift, attendance-issue, leave-today and current payroll-month headlines with native app links.633 is Deployed. Only634 is active; P4 waits for P3 Deployed.

The acting-user transport already exists as a system pattern: issueHandoffAudited mints for the same live platform account/session, the app exchanges it without a browser Origin, and a private request-local app cookie serves exact GETs before app-only logout. A separate Console-owned adapter follows that pattern; protected assistant files are neither edited nor imported. No CORS, cookie, machine key or handoff-auth behavior changes. The normal exchange retains its live-session-seat app-access check, even when a selected summary park differs; a refusal remains a refusal.

GET /staff/summary accepts only an optional core branchId. Core branches are live and operator-owned, with both section permissions in reach; the existing own-department app-access seam remains. The returned selection is explicit. Foreign/absent/archived parks404, own unreachable403. The app current user must carry the caller's platform stamp; its own branch metadata must uniquely map that selected core park within the same tenant. No platform HR/payroll table read, silent all-park fallback or inferred app salary role.

The four sources preserve existing meanings:

| Headline | Native source and definition | Destination |
|---|---|---|
| On shift now | GET/api/timekeeping/live, currentlyWorkingCount/timestamp; original18-hour latest-IN rule and advisor exclusion | /timekeeping-review?tab=live |
| Attendance issues | GET/api/timekeeping/review for the selected date/branch; returned issuesCount, including its original advisor/late/PIN/long/missing/no-show rules | /timekeeping-review?tab=issues |
| Leave entries today | GET/api/time-off overlapping the selected date/branch; count entries, with no invented approval/unique-person rule | /scheduling |
| Company payroll month | New app-owned GET/api/payroll/month-status; native Bangkok month and existing current version/status per active paying entity | /payroll |

Payroll setup and month-end reads can lazily seed defaults and return pay/bank/person data, so they are deliberately not called. The small status-only SELECT retains requireAuth, payroll(hr.view_salary), parkGroupOnly and the existing raw-advisor prefix refusal. Every entity/run/version join has tenant equality. No run is not-started; an own run with missing current version is unavailable. No setup/world/engine, write or migration. Company payroll retains its existing tenant-wide scope and is labelled separately from the park selection.

The public DTO contains only reachable park labels, selected date, counts/read times and company run status/version. Access refusals and unavailable data are distinct from0. Unknown upstream personal/financial/error fields, tokens and cookies never enter the DTO or logs. UI links use the existing one-use handoff and fixed native targets. Actor/filter/refresh changes hide old figures immediately; delayed responses cannot replace the current selection. Tests cover4cards, both navigation gates, fixed links, failures/zero and phone wrapping.

Actual local RED receipts under C:/w/admin634-integrated: api-first-red has29 missing-transport plus8 missing-route failures; console-first-red builds the current app and has7 feature failures/1 gate pass; app-native-red-v3 has7 missing-status-route failures/2 inherited refusal passes. Source manifest f6671c57 binds the first API run;8a72f1c binds browser/native REDs. Both host and copied API-doc inputs match for each. The earlier API starts stopped before dispatch while sync was pending or host source changed. Two native migration preflights stopped before tests because the external fixture lacked required otoapp schema. The new fixture creates that schema only in its exact private disposable database; the production migrator/guards are unchanged. All private native/Console/API test DBs were removed by their harnesses. Fresh app npm ci --ignore-scripts --offline --no-audit --no-fund passes.

Implementation is WIP, not a release. Root owns route/schema, generated contracts/registers, Git/Jira/docs/runtime; the other lanes own Console UI, app payroll projection and constrained transport/summary service with their tests. Two ticket-owned containers are needed until testing finishes; remove exact own IDs afterward and preserve the ten other containers plus images/volumes/networks. No owner/planner ruling, SMS, invitation, payment, check-in, hardware or channel action is pending. Whole local gates, exact-source CI, automatic deployment and postdeploy native screenshots remain.
