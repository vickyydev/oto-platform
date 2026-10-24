# SCRUM-631 cache assertion triage

Read-only source/log inspection; no production/test changes, test execution, Git, Docker, authentication or staging action by this reviewer.

## Observed result and limit

`C:/w/admin631-final/full-api-shard-1.json` records exit1, 11:41:55.499Z–11:54:53.482Z, frozen manifest `d7529fbcaed0acd681a83707e62217bff7b47567e9e2c81ae5a97f69946418cd`, unchanged host source. The sole failed assertion is `apps/api/test/booth-admin.test.ts:675`: the last `agent.syncCache()` returned all14 scopes instead of `[]`. Its preceding assertions already verified the newly published wheel reached the box and the apply command succeeded. The test does not show a wrong wheel or an unsuccessful apply.

The **whole unchanged39-case file** subsequently passes: `booth-admin-recheck.json`, 11:56:31.182Z–11:56:41.997Z, exit0, identical manifest and unchanged host. Log SHA256 `c3730030cd482c43c4c4e07508f9376a8d3590c91938c62255000b59e020c843`. This confirms non-reproduction in that run, not a repaired defect. The full failed shard is being rerun by the coordinator; this note does not claim its outcome.

**No exact causal scope, ETag value, missing local row or timer boundary is recorded in the failed log. Root cause remains unproven.** Do not label it a confirmed timing defect or declare Q16 responsible.

## Actual path

1. Test621–675 edits/publishes the wheel, queues `config_apply`, calls the agent's pending-command runner and checks both applied version and command history before asserting no further cache work. The agent's timers are deliberately not started (`booth-admin.test.ts:127-159`); the only separately started timer is the booth module. There is no fake clock or short-expiry fixture in this testcase.
2. `packages/box-agent/src/agent.ts:4331-4348`: `config_apply` calls `syncConfig`, `syncCache`, then heartbeat. `syncCache:2676-2733` returns the **full-bundle application list** from `pullBundle`; receipt/check-in/wallet/stock/event reads run separately and do not add to that return value.
3. `pullBundle:2941-3050` sends the held `bundleVersion` as `If-None-Match`. A304 returns `[]`. Before dispatch it drops the held validator if local staff/deny-list rows cannot be read. A complete200 applies every offered scope and returns their names; it does not mean every scope changed. A skipped/truncated pull deliberately forgets the validator. Thus all14 names establish a whole200 apply, without identifying which administered item changed or whether a validator was sent.
4. `apps/api/src/routes/box.ts:419-451` builds the current bundle, emits its ETag and returns304 only on an exact matching validator. `sync.ts:5633-5642` hashes JSON of administered scope content. `generatedAt`, global cursor and volatile receipt/band/check-in/wallet/stock/event scopes are **excluded**. Elapsed milliseconds or a volatile read alone cannot change this hash.

## Real instability mechanisms to distinguish, not diagnosed causes

- **Clock-sensitive administered content:** revoked staff tokens are included only while expiry is in the future (`staff-token.ts:313-328`); stopped-band deny-list uses a36-hour cutoff (`sync.ts:5350-5360`); bookings include a current-date window (`:5383-5396`); booth roster uses the branch trading date (`sync-booth.ts:1136-1140`); benefit keys/revocations/benefit days use the current instant/day (`benefit-credentials.ts:708-781`). Such a boundary can legitimately require a200 with no new administration. No such boundary was captured here, and the observed run is in the afternoon/evening rather than a UTC/local midnight transition. No evidence identifies an expiring fixture.
- **Unordered content:** the staff `SELECT DISTINCT ... LIMIT` (`sync.ts:5182-5205`), inactive-account list (`:5321-5326`), revoked token IDs (`staff-token.ts:313-328`) and several nested cache arrays lack deterministic ordering. JSON hashing is sensitive to array order even when the set of rows is unchanged. This is a concrete possible source of version churn; the failed run did not retain two payloads proving it occurred. Staff permission strings and booth staff IDs do have explicit stable sorting.
- **Validator reset/local cache read:** the agent deliberately forgets its validator on unreadable staff/deny-list rows, skipped scopes, clear-cache, credential rotation or outage recovery (`agent.ts:2957,3049,4360,4396,4457`). The failing assertion alone cannot distinguish this from a changed server hash. No corresponding warning/header/payload was retained in the failed output.
- The API test configuration uses `fileParallelism:false`, and each `createTestContext` creates/seeds its own database (`test/helpers.ts:28-73`). Other full-shard files do not share this fixture database. Parallel shard resource load is a possible environment difference, not demonstrated cross-suite data mutation.

## Q16 relationship

The only Q16 production delta is the department helper's initial owned-team/owned-department/exact-branch/non-null-external-ID SELECT plus three team-key arguments. It adds no table writes before the unchanged legacy fallback, changes no role/team/grant reference and is not called by cache generation or cache refresh. The ordinary fresh seed has native external-null departments, so the added lookup does not match and uses the same fallback before this test's box is registered. There is no evidenced Q16 data path that invalidates the box cache between the two pulls. This supports treating the cache assertion as a separate release observation while retaining its red receipt; it is not proof that any possible relationship has been experimentally excluded.

## Relevant byte equality

Each following file was SHA256-compared against both the current main checkout and `admin631-final/current.json`: **all match both**.

| File | SHA256 |
| --- | --- |
| `apps/api/test/booth-admin.test.ts` | `09004f3436fbe5830211734c647fa8ba2911a965151021a3791ff70ec7b3677e` |
| `apps/api/src/routes/box.ts` | `246db31c4b11afdb31b05029eda5be3661cce7d8b3311edf5376b4d4964d8354` |
| `apps/api/src/services/sync.ts` | `b5c002df28c3785e048cf235c416365db5b30da8affb70b18b8206332b6c7846` |
| `apps/api/src/services/sync-booth.ts` | `36f79077c818a723ba9baf9886362521b7e839cb7fd78eac951be54cfee684b5` |
| `apps/api/src/services/box.ts` | `3e6fafc0d145fbcc3b5256fd062d786755f140fb37bd5d8c3f20c324b33598b1` |
| `apps/api/src/services/staff-token.ts` | `fa456f0b6c02826e17d395a2c792269886d64858fea63b78f4c08c80639a09fe` |
| `apps/api/src/services/benefit-credentials.ts` | `450e7fa2598044b65ae5df47e4a2b5d8699c53e5190f2f6a655bb0347446bc78` |
| `packages/box-agent/src/agent.ts` | `678047d1e884378736b795d0f15b5766920b2e0bf81685e681863bde0e711523` |
| `packages/box-agent/src/store-sql.ts` | `2e60a58f4b94e8298bbd848e3e3431d029e7fc7e664531295e43e6cf031122dc` |

Suggested plain-language tracking: “The full local API run caught one extra cache refresh after the wheel had applied successfully. The unchanged complete Booth suite then passed39 checks. No code or assertion was changed; the failed whole API shard is being repeated, and the exact reason for that extra refresh is not yet established.”
