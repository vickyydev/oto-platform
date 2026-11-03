# SCRUM-726 early stream disconnect

The first load attempt stopped before its first payment because the browser harness selected a modifier dialog that this test item does not have. Its one unpaid draft was voided through the normal API, with zero payment attempts. The corrected native journey then completed one one-baht cash sale, independently matched to one approved cash attempt. These are diagnostics, not capacity results.

The same diagnostic found a product defect on API source `7a00aa1ce44af50622d3cde0bd5e84f80607c2a6`: the server still counted a station subscriber after its browser had closed. A second disconnected context left a second subscriber. The client had no open stream in either case.

`openChannel` could run after asynchronous authorization finished, even though the response's close event had already fired. It would attach a subscriber and heartbeat with no later close event to release them. The fix checks the request's aborted state and the response's destroyed/ended state before attaching. A normal completed request is not treated as an aborted stream.

The real-socket review in `apps/api/test/s726-channel-close-review.test.ts` first pinned the finding with `it.fails`. Turning it into a normal assertion before the fix reproduced a failure: the attach callback ran once after the socket had already closed. After the guard was added, both cases passed:

- A normal connected stream retains its event-stream and no-transform headers, then detaches exactly once on disconnect.
- A socket closed while authorization is pending never attaches a subscriber afterwards.

There is no change to authentication, authorization, sale handling, payment handling, offline routing, pool sizing or Render plans. Full gates and the subsequent live-browser disconnect receipt are recorded separately. The load remains paused until the corrected source is live and that check passes.

The interrupted harness's two exact sessions were ended through the normal sign-out service and independently read back. The previous read-only monitor was canceled while the fix was gated. See `orphan-sessions-cleaned.json`, `monitor-stopped-for-fix.json`, `draft-void.json` and `browser-diagnostic.json`.
