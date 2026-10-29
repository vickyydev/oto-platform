# Park-switch browser fixture review

Read-only source review of `C:/oto-lanes/admin684-release-20261030`. No repository edit, browser, test, API, Git mutation or Jira action ran for this review.

The test fixture has a real ordering dependency. `apps/console/e2e/page-state-review.spec.ts:98` fills `parks` only after the branches response has arrived. Its boxes handler starts at line 101 and only rewrites the first park's box name when the response's branch ID equals `parks[0]?.id` (line 106). A boxes response handled before that metadata arrives is passed through with its original name.

`apps/console/src/pages/Devices.tsx:131` initializes the selected branch from the already-loaded session. Its directory read at line 134 and fleet hook at line 148 start independently. The fleet starts its boxes read at line 609; `workingAuthority.ts:16` checks authority around each operation but does not serialize them. It is therefore valid for the initial boxes response to arrive before the directory metadata. If the selected park is already the first park, the test's line 118 deliberately makes no selection, so no second boxes read corrects the missed fixture rewrite. The line 119 baseline then fails even while the page displays the original, successfully loaded fleet.

This permitted execution order matches the reported CI snapshot: the first park is selected and ordinary box rows appear, while the synthetic starting label is absent. The exact CI response chronology was not recorded, so that particular occurrence should remain described as a source-supported diagnosis rather than a captured timing trace. The unchanged six-case local pass is consistent with the opposite ordering.

The smallest repair is test-local readiness synchronization:

```ts
let parksReady!: () => void;
const listedParks = new Promise<void>(resolve => { parksReady = resolve; });
// In the existing branches handler, immediately after assigning parks:
parksReady();
// At the start of the existing boxes handler, before either parks comparison:
await listedParks;
```

Resolve only after assigning the metadata. Keep the original baseline, picker selection, held-B/read checks, absence assertion and release/cleanup unchanged. Keep all timeouts unchanged. Do not change Devices or its request scheduling to accommodate the fixture. This delay applies only to the fixture's response preparation; after metadata is ready, the B request is still held exactly as before and the product must still clear A's rows while B remains pending.

If a deterministic demonstration is needed, use an external, source-extracted handler calibration with a fake route and controlled metadata promise, rather than a new product test suite or an arbitrary browser sleep. Start the original boxes handler with `parks=[]`, allow its fake fetch/body to finish, and observe that it fulfills the original name; the existing sentinel-name assertion fails. Start the corrected handler under the same initial state and confirm it neither fetches nor fulfills before metadata is released. Then assign the two parks, release readiness, and require the same sentinel-name assertion to pass. A second control starts B after readiness, requires it to remain held before release, and then confirms normal fulfillment. These are proposed checks, not executed results.
