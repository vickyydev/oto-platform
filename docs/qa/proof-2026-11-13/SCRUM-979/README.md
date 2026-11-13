# SCRUM-979 API staging proof

API source 0ea85faaf5b4e62204eaabdda5d691dd2b9a248c reached staging through dep-dbrevcgu01pc73b1vjp0 at 11:13:52 UTC on 13 November. The API identity was verified again during and after proof. The till ran 26c308ed; the Console advanced from that commit to docs-only checkpoint 7f5ac6f13 during cleanup, with its source unchanged.

The real staging till completed one simulated card sale for 1,040 baht with one SALE command. A separate deliberate silence reached staff review after two minutes. After 10 minutes 14 seconds, the branch Health summary counted two waiting card payments, up from the one-payment baseline. The native Console displayed the alert. After the own held attempt was declined and its sale voided, the summary returned to one. Exact attempt membership is covered by the integration test because Health does not expose attempt IDs.

The paid test sale was refunded through one successful simulated terminal VOID; the other sale is voided. The exact station and three devices were archived and verified. Sales and refund audit history remain intentionally. Till, Console, manager and admin sessions returned 401 after sign-out. There is no active proof browser or fixture.

Five inspected acceptance images and hashes are named in release-evidence.json and copied to the ticket attachment directory. The initial locked-screen image and provisional refund-pending cleanup card remain as attempt records; they are not acceptance images. The local caller timeout did not restart or interrupt the real observation. A cleanup assertion was corrected from void to the actual voided enum; the existing successful void was read back, not recreated.

Local gates: 406 tests across 15 API files, zero-output API typecheck, generated contracts and all changed TypeScript files lint clean. Exact-source CI run 43414621425 is still running at this checkpoint; checkpoint run 43412925149 is green. No physical terminal proof or staging reproduction of lost posts/reference collisions is claimed. See review.md for retained lower-priority findings. The whole ticket remains In Progress until the next 977/975 lane delivers its till points.
