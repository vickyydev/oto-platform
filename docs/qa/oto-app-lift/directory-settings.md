# SCRUM-193: Directory API and Settings dependencies

The existing Directory API has six service-key routes for one employee, employee search, a branch roster, roles, departments and branches. The middleware checks one `HR_DIRECTORY_API_KEY` value and rate-limits it. Neither that key nor the request identifies a tenant; the storage searches and reference lists can span all tenants. The platform consumer and OTO App need an agreed tenant-bearing service contract before a multi-tenant staging claim. No service key value was read or recorded for this review.

The `settings` table has a globally unique `key` and no tenant column. The app's settings helper and several module routes read and upsert by that key. Changing only `/api/settings` would leave the other callers global. A forward-only platform-lane migration must add tenant scope and define what happens to existing global keys before the OTO App lane can update every caller safely. The exact migration and service contract requests are in the SCRUM-193 Jira comment and STOP POINT block.

Both modules are **blocked on the platform contract**, so no signed-in or multi-tenant staging proof is claimed. Once provided, verify separate tenants' settings values and Directory employee/branch results, including denied cross-tenant requests, and attach named staging screenshots before marking the module complete.
