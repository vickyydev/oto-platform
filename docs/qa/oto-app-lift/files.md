# SCRUM-193: General file delivery

The app already uses the platform object bucket for uploads, PDFs and media, with local file reads retained only for old paths in local development. The general `/api/files/:folder/:filename` route still serves specific public folders for logo/profile and check-in link use, while private documents have record-scoped routes and are refused by the generic handler.

The generic handler now rejects invalid folder and filename path segments before either the object-store lookup or local fallback. It sends `private, no-store` for authenticated folders and `public` caching only for the declared public folders; the same headers apply to both object-store and legacy local responses. It also disables content-type sniffing.

This is a partial files checkpoint. Other authenticated generic folders still rely on account authentication rather than record/tenant authorization, and the publicly shared drop-off photo and signature URLs remain accessible to anyone who has the URL because the current check-in workflow sends those URLs outside the app. A record-specific access design for those media routes is needed before the full files module can be called verified. No secret or child image was read during this work.

Verification: production build passed. App typecheck remains at 542 inherited errors with none in the changed file route, and scoped lint is clear. No existing file-route test exists. Staging anonymous guard, invalid-segment and cache-header checks, plus signed-in record-scope screenshots, remain.
