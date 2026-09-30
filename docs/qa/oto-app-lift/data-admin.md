# SCRUM-193: Data admin access alignment

The live generic data editor remains at `/data` with its model index, schema view, record list, detail and create/edit screens. Its server API is guarded by `requireGlobalAdmin`, which accepts global admin and the original legacy admin role, but rejects operator admin. The client route gate previously allowed operator admin into all six data pages, where the API then refused every request. The route gate now matches the server rule.

The generic editor is a privileged maintenance tool and is still backed by the original model registry. The vault access-item model was removed from that registry by SCRUM-463 so credentials cannot bypass the audited vault reveal. The remaining models need a separate review before any claim that the data editor is safe for production data, especially session and integration records. This is recorded as a S2-17b caveat, not a Deployed claim.

Verification: production build, app typecheck delta, scoped lint and staging anonymous guard checks are required. A signed-in global/legacy admin walkthrough and operator-admin denial screenshot remain before this module can be marked verified.
