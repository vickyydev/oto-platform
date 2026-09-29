# OTO App lift: local kiosk security slice (30 September 2026)

SCRUM-193 remains In Progress. SCRUM-261 and SCRUM-262 are the kiosk defects covered by this slice. Staging deployment and screenshots remain pending, so none of these tickets is Deployed on this evidence alone.

The image endpoint checks the active kiosk device before accepting a multipart upload, sends the same credential for the existing multipart and JSON client paths, and limits requests by address and device. The JSON path accepts JPEG or PNG data up to 5 MB. The failed-face-report endpoint limits requests by address and device before it writes an audit row. These counters are process-local, as are the app's existing kiosk throttles; staging currently runs one app instance.

Verification used an isolated local PostgreSQL database and the app's existing kiosk authorization spec. The spec passed 12/12 checks, including anonymous and invalid-device refusals and address ceilings. A disposable local kiosk fixture then proved that a configured device could upload a PNG, the photo endpoint returned 429 on request 31, and face-failure logging returned 429 on request 121 after exactly 120 rows. The fixture, log rows and local image were removed after the check. The production build passed. The app typecheck remained at its inherited 583 errors, with no added errors. A scoped ESLint run found no diagnostics on changed lines; inherited diagnostics in the large existing source files remain.

Before these defects move to Deployed, verify the updated kiosk flow on oto-app-staging and attach named screenshots or a reviewed test-run card to each Jira ticket. Do not run the local ceiling loops against staging's shared address.
