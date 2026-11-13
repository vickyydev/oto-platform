**14 November 2026: root source review is now approved; resume landing and delivery without another owner approval.**

# SCRUM-982 scope-repair review handoff

The source repair is concrete and all local gates are green. Root review is the
remaining pre-landing gate, explicitly required by the design review. Do not ask
the owner to authorize the already-approved round again.

- Worktree: C:/oto-lanes/codex-payment-handover-20261113
- Branch: lane/codex-payment-handover-20261113
- HEAD/main: dff15bc27013edee5f9d43b58b4210460da6c331
- Current staged product: 157d6cb24d1764dea4d5356615942882f2970e7c on both tills.
- Main CI 43435242291: five jobs green, workspace failed the real corrected-cart
  regression. No rerun is appropriate for that broken source.
- Uncommitted repair: recordedPaymentScope.ts, five selling-screen integrations,
  four scope runtime cases, eleven adversarial pins and two source-resume pins.
- Local proof: 274 files / 3,902 POS tests, three POS type configurations,
  zero-output API types, lint, eleven review pins and seven production-build
  browser cases all pass. The original corrected-cart test is unchanged and now
  passes its two-row, amount and quantity checks. Disposable database removed.
- Gate receipts: cart-scope-validation.json; logs and full manifests are in
  C:/oto-lanes/audit-takeover-20261113/982-scope-*.

## Review and release

Review the concrete diff, especially replay AND resumeSaleId scope gating,
lexical scope capture before every actual commit, late outcomes and frozen
adopted ticket resumes. If approved, follow up handover_delivery to land this
fix. Rebase and inspect the commit list; update STATUS/CODEX/CLOUD and Jira in
the same push turn. Deploy only the two named tills at the landed full SHA and
watch its full-SHA CI. Source changes require fresh final-source proof.

Do not declare SCRUM-982 Deployed from the old-source pictures. They are
historical. The final matrix needs desktop ticket/F&B/Shop, phone ticket/F&B,
QR introduced and paid while locked, waiting card and a genuine cart correction.
The handover scripts already exercised the first six cases; use their corrected
native sequence, including the phone family-review/return-to-staff steps. Root
must read current SCRUM-964 scope before sharing bounded evidence/transitions.
SCRUM-981 remains In Progress for its holds and the stage 3 forward-only app view.

## Exact fixture state

All old-source money is closed: six paid sales refunded 353,500 satang in full,
one unpaid card setup sale voided with zero attempts. All three old stations
are archived and have zero device assignments. The one display credential is
revoked. Three browser contexts signed out, read /me 401 and closed; the proof
browser is closed. The two synthetic staff accounts have zero live sessions.
Only the own simulated terminal is retained active and unassigned for final
proof. exact-ledger.json and receipt.json contain exact IDs and readbacks.

The driver is still running as PTY24721 at localhost:47982, with passwords only
in its closure. It can create fresh stations through S.makeStation; remaining
unused checked phone numbers are in S.free. Before a terminal tender, wait for
the own station/device config to reach the virtual box: the first outcome
control returned NO_SIMULATOR_FOR_DEVICE before a config pull. No card attempt
was sent. Do not touch shared device configuration, FWBooth1 or real data.

The initial 01a image has a late-rendered unmasked simulator QR and is excluded
from commits/attachments. The corrected capture masks both payment-qr and its
waiting placeholder. Several intermediate phone images show the existing
hand-to-family prompt or printer notice; choose only inspected final staff
views for publication and retain the original intermediate evidence.

## After this unit

Only after required proof, exact cleanup, CI/evidence/Jira readback and checkpoint
are complete, notify root and use the authorized followups to the existing
beo_stage3_audit and deposit_stage3_audit agents for the approved stage 3 work.
Follow root's saved partition/order and review-before-landing rules. No service-
inclusive feature or pricing/settings change is authorized. Stop after stage 3
for owner review.
