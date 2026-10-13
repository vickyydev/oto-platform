# Returning-family verification - SCRUM-522

## Staging evidence - 13 October 2026

**WORKS for the recorded SMS verification, saved-family prefill and API registration controls.** The staging application ran `5b2f049fba750403fe60284bf2b8b4855eb934b4`.

The public registration screen required verification before showing the saved synthetic family's details. The first journey used one authorized SMS request. The recipient received the code and supplied it for the real screen's verification action. After verification, the screen automatically retrieved and filled the matching synthetic child and guardian details, and hid the verification prompt.

A second authorized code was verified through the real screen. The resulting grant was used in an API request to save the same registration. This exercised the real registration endpoint, not the screen's normal Submit action. The response retained the existing registration ID, attendance, signature and agreement date; no new registration was created.

| Observed action | Result |
| --- | --- |
| Look up the returning family before verification | HTTP 200 with `found: true` and `verificationRequired: true`; no private family details returned. |
| Request the first verification SMS | HTTP 200 with a challenge; actual receipt was confirmed by the recipient. |
| Verify the received code through the screen | HTTP 200 with a grant. |
| Automatic lookup after verification | The screen filled the exact synthetic child and guardian details and hid the verification prompt. |
| Reuse the original lookup grant after the screen exchanged it | HTTP 403: used-grant refusal. |
| Verify the second authorized code through the screen | HTTP 200. |
| Save the existing registration through `POST /api/public/camp-registrations` | HTTP 200 with the same registration ID; attendance, signature and agreement date unchanged. |
| Replay the consumed write grant | HTTP 403. |
| Use a valid grant against a camp in another park | HTTP 403. |
| Use that same still-valid grant against the owning park after the refusal | HTTP 200 with the same registration ID. |

The foreign-camp case used a valid grant and was followed by a successful own-park request using that same grant. It is separate from the used-grant refusals. No phone number, verification code, grant or provider identifier is included in this record.

## Inspected staging evidence

[Verified-family screen](../../jira-comments/attachments/SCRUM-522/family-verified-staging-20261013.png) was saved with the telephone field masked and visually inspected. The inspected [verification and saved-write card](../../jira-comments/attachments/SCRUM-522/family-verification-write-staging-20261013.png) records the actual receipt, API save and grant boundaries.

## Validation and remaining acceptance

All six hosted release jobs passed. The 89 feature runtime controls include family-verification controls; those hosted results are separate from the staging journeys above.

The synthetic registration was added by a manager. The API save retained its existing details and does not establish fresh parent consent or a new signature. The normal screen Submit action was not exercised in this journey. Remaining parent-story acceptance and exact fixture cleanup stay open.
