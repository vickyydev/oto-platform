# SCRUM-720 staging result - 2 November 2026

**Deployed by Jira read-back. Request rate, record writes and the silent gap all moved as decided. The display's end-to-end delay stays above SCRUM-710's target on today's POS address; SCRUM-710 stays in Testing.**

Source: `ecca33f9` (API) and `2513e1fb` (POS), in release `f227d9bf`. All six jobs passed in [CI 41432225603](https://github.com/vickyydev/oto-platform/actions/runs/41432225603). POS went live at 11:22:48Z and API at 11:25:36Z. The after run measured from 11:25:49Z to 11:28:39Z.

Run [41425308521](https://github.com/vickyydev/oto-platform/actions/runs/41425308521) on `2513e1fb` itself had `pos-tests`, `oto-app` and all three API shards green and `ci` red twice at `packages/box-agent/test/storage.test.ts:100`, which this lane does not touch; 774 of 774 box tests passed locally on that source. SCRUM-719 changed the mirror's ten-second floor and landed an installer pattern fix (`8d274901` failed at Pi scripts parse, `f227d9bf` passed). `f227d9bf` is the first green run that carries this lane.

Every check used the station **ZZ TEST SCRUM-710 display**, station `01a19afe-d88c-74d2-b7b9-7cdde25d43b8`, box `01a19afe-d33c-7ea1-b583-c525b9322da7`, with real browsers: one till, one paired customer display, one Console. Pairing used the Console's Pair a display form. No payment, SMS, member creation, Till 1, Till 2, park Pi or FWBooth1 operation occurred; the synthetic phone stayed a walk-in and Charge was never pressed.

| Measurement | Before, first run | Before, second run | After |
| --- | ---: | ---: | ---: |
| Display requests, one idle minute | 87 | 88 | **44** |
| of which `display/session` reads | 84 | 85 | 41 |
| of which `display/channel` attempts (the path cannot carry a stream) | 3 | 3 | 3 |
| Record prepared-at across that minute | moved | moved | **unchanged** |
| Till requests, one idle minute (not part of this change) | 126 | 115 | 125 |
| Silent gap: total hidden after the last reply | 21.1 s | 20.7 s | **15.1 s** |
| Silent gap: Reconnecting shown after the last reply | 6.4 s | 5.6 s | 6.1 s |
| Recovery after the line returned | 1.3 s | 1.3 s | 0.8 s |
| Record follows a direct stream, polls stopped | not measured | not within 30 s | **5.6 s** |
| Till Add to order press to customer screen | 873-1,088 ms | 1,346-1,789 ms | **1,213-2,720 ms** |
| Customer answer to the till's lookup | 1,416 ms | 1,413 ms | **1,750 ms** |

**The delay, as measured.** Both directions stay above the 500 ms target. On this path the one-second gap adds about half a second on average to till-to-customer, because the display reads less often; a stream replaces the gap once SCRUM-718 gives the POS a path that carries one. The customer-to-till figure is one sample on each run and does not read the display's gap, so its movement is the path's own spread.

**Writes per idle minute.** Each answered poll cost the credential touch and the snapshot upsert, about 170 writes a minute at 85 polls. It now costs the touch alone, about 41 writes. The touch's rule is unchanged: the display's last-seen time moves on every call. The Console's "Prepared at" now means when this content was first answered.

The record check opened a direct stream to the API with the display's own credential, held in memory and never logged, and stopped the browser's polls for its length, so only the stream could write the record.

**Proven by tests, not staged here:** a till recovering after its box comes back from an earlier copy, and the refused-claim wait, because staging them means restoring a box or making a station not ready. Each decision has a pin in `apps/pos/test/s720-publisher.test.ts`, and each pin was checked by undoing its decision in the source. All 29 such changes were caught, one of them after its pin was made stronger.

Cleanup: the test display was revoked at 11:28:37.380Z through the API the Console uses; read-back shows that credential revoked and zero active displays on the station. The screen returned to pairing and its replacement code was expired. Both staff sessions signed out with HTTP 200. The ZZ TEST box and station remain for follow-up.

Evidence:

- Inspected card, attached to SCRUM-720 as Jira attachment **12224**: [s720-staging-proof.png](s720-staging-proof.png). Exact copy: `docs/qa/jira-comments/attachments/SCRUM-720/s720-staging-proof.png`.
- Receipts: [s720-after.json](s720-after.json), [s720-before.json](s720-before.json), [s720-before-first.json](s720-before-first.json).
- Native PNGs: `s720-paired-dialog.png`, `s720-till-order.png`, `s720-display-order.png`, `s720-gap-reconnecting.png`, `s720-gap-paused.png`, `s720-gap-recovered.png`, `s720-revoked.png` (pairing code masked).

Local validation before the push: POS 1,601 tests, the seven built till journeys, API and POS typechecks, touched-file lint, API-types seam 10 of 10, and 319 passes with one existing TODO across the 13 API suites that read the display routes. The full API shards and Console journeys ran in CI. No test or guard was weakened. Two existing display pins in `s710-display.test.ts` moved with the poll gap, from 200 and 250 ms to one second, and one now also asserts its poll was on the wire.
