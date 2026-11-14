# CI fixture clock repair for SCRUM-844 delivery

The main run selected Saturday prices after the Bangkok trading day changed at 05:00. These tests had weekday carts and weekday expected amounts but left Date live. The exact original c3186 tree reproduced all six CI failures across the three complete files; that red was not repeated.

Only three test files change. Both static S768 files fix Date to Thursday 2026-11-12T05:00Z (noon Bangkok), using Date-only control and real-timer teardown. The S959 browser page gets Playwright setFixedTime before its first navigation, keeping rendering and timeout timers real. Prices, explicit weekday/weekend cases, assertions, thresholds and the full-width geometry fixture remain unchanged. This repairs test setup, not product pricing.

Validation: 86/86 in all three complete files; all three POS type configurations have zero diagnostics; touched-file ESLint exits 0. Git confirms no product/source/config/geometry change. A UTF8 comparison confirms all 128 existing expectation lines remain identical. Assigned independent review is next, followed by the necessary repair push and full-SHA CI watch. Main red continues to block features.

Original run 43517660340 passed the app job's 122 steps with no skips; only POS failed overall. The app remains live at c3186 and native proof is incomplete. Its interrupted synthetic event is archived, no deposit was saved, both sessions read 401 and the browser is closed. After green repair CI, bind proof to the actual running app SHA and unchanged app code. No production, real messages, service-inclusive pricing or owner-held behavior changes.
