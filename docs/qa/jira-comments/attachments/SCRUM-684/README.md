# Nullable response-contract correction

SCRUM-684 follows the confirmed final-audit findings under SCRUM-679. Three existing response descriptions rejected valid nulls in eight enum fields. Runtime Zod validation and serialization were already correct. The scoped change uses three route-local Swagger callbacks and adds null only to those eight generated enum lists. No global conversion, business behavior, permission, input, migration or service changes.

The [focused handoff](focused-handoff-v1.json) binds eight original failures and six controls, then 14 strict passing cases included in 257 passing affected/guard checks. Both affected compilers, ten client seam checks, generated contracts and five-file lint pass. [Source scope](source-scope-v1.json) and [whole document comparison](openapi-diff-v1.json) bind the exact narrow change. The [original red test](red-test-source.ts.txt) is preserved; all eight original failure assertions remain. Detailed source manifests and logs are hash-indexed externally in the handoff.

The first local full-API attempt overlaps the coordinator's rebase over documentation-only main. Even matching end hashes cannot exclude a transient file reset, so [that run is explicitly diagnostic-only](full-api-v1-qualification.json). Repeat the full release battery on frozen rebased source and retain both attempts. No full release, main landing or repaired staging acceptance is claimed by this checkpoint.

Separate preview diagnosis now confirms valid PNG bytes from both direct staging sample endpoints on the old release; the seven empty browser-capture observations still need reconciliation. Two privacy-mask observations are also separate from this response-schema repair. Parent 679 remains Testing. Docker stays off.
