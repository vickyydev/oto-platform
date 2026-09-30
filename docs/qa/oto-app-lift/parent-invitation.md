# SCRUM-456: parent invitation image and RSVP

The renderer now reads its decorative artwork from the built `dist/public/oto-assets` directory (with the source directory for local development). It escapes editable text, embeds only bounded JPEG/PNG/WebP bytes from the invitation object path, and disables Chromium page scripts with a restrictive document policy. The public photo uploader uses a MIME-derived extension. Concurrent RSVP submissions with the same guest identifier serialize to one record; invalid RSVP details return 400.

An isolated local parent token and event produced a JPEG invitation with the photo and artwork. A second rendering with markup in the child/location fields and an external photo URL displayed the text literally, used the placeholder photo and made zero requests to a local network sentinel. Both images were visually inspected. Two simultaneous RSVP posts returned 200 and left one row; an incomplete RSVP returned 400. Event, token, RSVP, design, photo and generated image fixtures were removed, with zero residual database rows. No new test suite was committed.

The production build passed. App typecheck stays at 577 inherited errors; its one diagnostic in this route is on the unchanged token-query expression, and the edited lines add none. Scoped ESLint reported 15 inherited diagnostics and zero on changed lines.

The public parent and guest links remain valid until revoked under the existing schema. A link-expiry policy is an open owner decision; adding an expiry column would require the platform lane. A positive staging invitation generation and named screenshot are still required before SCRUM-456 can be Deployed.
