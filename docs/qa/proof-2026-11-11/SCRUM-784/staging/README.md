# Unit 7 staging reproduction

Before code changes, attempt 03 pressed Create Login on one new ZZ TEST employee: HTTP 200, launcher sign-in and one-time password displayed. The picture masks the password and phone. The old automated check separately reproduced HTTP 400 because it omitted actionId and phone. No production login-route change is needed.

The synthetic, one-page PDF uploaded and indexed, but Generate SOP returned HTTP 500 with the provider's refusal that temperature is deprecated. The native error toast is pictured. The PDF text/render was inspected.

The core account was deactivated, app grant unlinked, employee graph deleted (404), and uploaded PDF deleted (404). The inactive account and audit trail remain by design. App, launcher and Console sessions all returned 401.

Attempts before and before-attempt-02 stopped because the harness had not opened the Access tab. Their employees were deleted and all sessions signed out; receipts are retained. The successful reproduction is before-attempt-03/receipt.json. The fixed-release proof is recorded below.

## Fixed release proof

Passed on 11 November, source 22263520da3218805bf520d300966e9a739c3b41. The authenticated /api/qa-reports/config reported that exact version before and after the native screen flow. Named Render deploy dep-dbq64dgn74is739r6dt0 was requested; subsequent control-plane reads timed out, so its last reported pre-deploy status is not presented as a final receipt. The app's own version establishes the running source.

Create Login returned 200 and displayed the one-time launcher sign-in. The PDF returned 201 with four structured steps, saved as draft, and the Studio SOP editor contained four step cards. The screenshot shows the editor's visible upper portion; the receipt counts all four cards. Three fixed-release pictures were inspected. No model key was used by automated checks; these two explicit staging SOP presses used the deployed feature.

Cleanup passed: own account inactive, grant withdrawn, employee/PDF/SOP each deleted and read back 404, app/launcher/Console 401 after sign-out. The inactive account and append-only audit records remain. after/receipt.json records ids and statuses. Main CI 43022323315 and immutable exact-source CI 43022494903 remain running at this checkpoint; watcher sessions 73375 and 22487. Under the owner's 17:32 staging-first ruling, Jira may reach Deployed after the inspected pictures are attached; never Done.
