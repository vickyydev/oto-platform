# Private files - release rechecks, 13 October 2026

WORKS for the recorded staged file reads on appd18d3fd8. The existing four synthetic payroll exports (bank, journal, SSO and PIT) and payslip PDF each return200 for the owning park,403 for another park and401 signed out. No calculation or new payroll file was generated.

The generated Fix image and test drop-off signature each return200 for their owning park,404 for another park and401 signed out. The event BEO request returns302 for its park and downloads a49106-byte PDF; another park is refused404 and signed-out request401. That existing exact BEO object's fingerprint was refreshed in the ignored cleanup ledger after rendering.

Evidence: inspected [private-file test-run card](../../jira-comments/attachments/SCRUM-191/r7-private-files-release-rechecks-20261013.png). Private capabilities, storage paths and contents are excluded. Exact object/record removal is the remaining cleanup step; this page does not claim it complete.
