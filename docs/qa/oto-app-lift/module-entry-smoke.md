# SCRUM-193: local module entry screens

A temporary browser probe signed in as the isolated full-seed admin and navigated 24 app routes. Each stayed on its requested path without a browser page error or generic application-error marker. The probe was removed. This is a render/navigation check only: it does not establish data correctness, a write action, branch scope, or staging behavior.

- HR and administration: `/users`, `/policies`, `/settings/access`, `/employees/casual`, `/org-chart`, `/attention`, `/activity-logbook`, `/settings`, `/analytics`.
- Studio and knowledge: `/studio/kb`, `/studio/kb/files`, `/studio/quizzes`, `/studio/children`, `/studio/form-builder`, `/studio/event-settings`.
- Core operations: `/core/checkins`, `/core/checkins/dropoff`, `/core/checkins/service`, `/core/find`, `/core/ask`, `/core/learn`, `/core/my-availability`.
- Data administration: `/data`.
- Voucher route: `/studio/vouchers` rendered the intentional “Vouchers have moved to the Console” notice. The platform lane confirmed on SCRUM-193 that this is the S2-17b end state: the platform voucher ledger is the single active system, with management in the Console and redemption at the till. Legacy OTO App voucher rows remain read-only history. Manager issuance and staff QR viewing belong to the later S2-17c/S2-21 contract pass, using platform API data rather than reviving the old store.

The remaining modules still need one real write or action each on staging with screenshots, or an explicit disabled-on-staging reason. The signed-in launcher staging session is pending. Xero sandbox configuration, platform job-run visibility, POS views and the restore rehearsal are separate open acceptance items.
