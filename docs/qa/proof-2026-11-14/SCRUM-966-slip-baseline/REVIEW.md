# Independent review pins: prospective slip baselines

This candidate implements approved partition E of SCRUM-966 / SCRUM-945. Root approved the design before implementation; independent source review of the concrete candidate remains required. It changes only party-slips.ts, party-plan.ts and dedicated API tests. There is no migration, shared composer bump, settlement/pricing/editor change or physical-printer claim.

## Original findings and prescribed fixes

- HIGH: the first tick after an older composer replaced the previous held content with the current plan. A genuine Margherita-to-Hawaiian edit and a kitchen-to-bar routing change disappeared. Persist the previous semantic composition input and resolved routing, recompose that before side under new code, then compare the actual current plan.
- HIGH: an absent view row was reported as source legacy. Disappearance wrote a fake composer epoch; a returned same or changed plan was silently rebased away. Distinguish row presence internally, retain each station's last known composer, and compare a recorded empty VOID state against a returned plan. Never invent an epoch for an unmarked missing historical row.
- HIGH: after a silent rebase, cancellation could VOID the normalized logical presentation rather than the lines actually given. Cancellation must use the actual last-given print/change document, including when a normalized mark matches the current composer.
- Historical limit: old rendered rows cannot reconstruct missing semantic inputs. Preserve the established one-time rebase-to-current fallback, audit why it happened and capture a snapshot prospectively. Invalid version, malformed fields, missing routing or mismatched given-run source must not be guessed.

The complete original service file with ten new integration cases failed nine assertions and passed 48 controls. This includes real choice/routing loss, fake missing-row epoch, unmarked empty-state loss, actual-paper cancellation and three explicit fallback-audit pins; no setup failure occurred. original-red.json binds the unchanged service blobs and original log hash. Additional final controls prove actual legacy-versus-absence metadata and stale given-run source handling.

## Final approach

The existing held JSON retains lines/orderRef and adds an optional version-1 serializable composeInput: set-menu and bar semantics, timing, counts, cake, party title/location and resolved route answers including explicit null. Existing shared schemas validate it. Prices, unrelated line identifiers/catalogue flags and separate customer/contact/settlement columns are not stored. A supported null-plan snapshot with fingerprint none represents known empty state; it is distinct from absent historical JSON.

On a composer mismatch, only a snapshot tied to the actual latest given source is trusted. Each station's previous snapshot is recomposed with its saved routes. A normalized previous mark is written in the existing locked transaction even when no change prints. If change slips are written, only those stations advance to the actual change:run/current snapshot. The existing advisory lock, action replay, branch routing and per-station behavior remain. Cancellation reads actual paper content. A missing row still follows existing absent/void policy; it is not globally redefined as unknown.

## Validation and limits

The initial fixed batch passed all 95 tests across four complete API files: party-slips 58, snapshot review 11, related menu 19 and prep 7. Whole API compiler output was zero bytes; touched-file lint passed. After adding the final stale-source control, the changed complete integration file passed 59/59, whole API types again produced zero bytes and touched lint passed. Final unique coverage is 96 tests across four complete files; the batches overlap and are not additive. validation.json binds the exact source and raw-log fingerprints. Tests are serial against disposable embedded PostgreSQL with Docker off and no vitest name filtering.

The suite covers unchanged upgrade, an edit before the first upgraded tick, one-station/routing differences, same/changed returned plans, no-snapshot/malformed/version/routing fallback, known empty historical state, real legacy rows, actual-paper cancellation, replay and concurrent ticks. Snapshot review separately checks round trips, provenance/notes/times/cake/counts, invalid input and exclusion of unused money/contact fields. Local cleanup checks only exact PIDs recorded by this lane and leaves unrelated servers untouched.

No staging fixture/session was created. Root-approved landing is still conditional on concrete source review, the ordinary fresh rebase/commit-list checks, resolved main CI red and the active release slot. The current main red is a separately reproduced live-weekend POS fixture issue on the app844 release; this lane does not edit those POS tests. Named exact-source CI/deployment, bounded native proof, inspected images/Jira and exact cleanup remain owed after approved source landing. Physical printer output and reconstruction of already-lost historical edits remain unproved.
