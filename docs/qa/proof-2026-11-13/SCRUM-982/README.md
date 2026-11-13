# SCRUM-982 and scoped SCRUM-981 proof

Source review and focused gates are in REVIEW.md. Native staging proof is pending.
The source changes collection recovery and narrow display/read-only wording only;
it adds no API behavior, migration, production operation or physical-hardware claim.

Planned native matrix: desktop ticket/F&B/Shop plus phone ticket/F&B through a
waiting QR and a different proof account, true paid-QR completion, cancelled-QR
then cash, and a bounded waiting-card handover. A separate case introduces and
pays a QR while a sale with no earlier attempt is locked. Confirm one sale per
journey, original seller, actual tender and no Cash gesture for QR completion.
Capture both staff screen and paired display where applicable, inspect every retained
PNG, and bind the two till deployments before and after. QR codes and other
families/staff are masked. The two reused ZZ TEST 964 staff keep their original
names/history; their exact committed identity must match fresh inactive and
readback showing zero live sessions before reactivation. The account-create route sends
SMS on staging and must never be called. Temporary/final passwords stay in memory.

Cleanup refunds only this proof's simulated paid money and voids its unpaid sales,
revokes its displays, removes device assignments and archives its own stations,
deactivates the two synthetic staff accounts again and verifies all sessions ended/401.
The independent exact-ledger.json preserves safe fixture IDs for resumability.
Stage 3 holds include the forward-only app-view repair for the set-menu/extra-name
collision; SCRUM-981's owner-held behavior and shared End-of-Day composer remain open.
