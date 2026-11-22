# Staff password recovery and phone verification

The API and launcher at otoplay.org serve release
`669e1c00f1662813a66d067f061a3c1beff9b9eb`. All six jobs passed in the
[candidate run](https://github.com/vickyydev/oto-platform/actions/runs/45021827698)
and the [main run](https://github.com/vickyydev/oto-platform/actions/runs/45026346954).

| Check | Result |
| --- | --- |
| Production API and launcher | Render deployments `dep-dc1f4s2jnfac738jsm1g` and `dep-dc1f79bl550s73eb7o10` both reported the release above as live. |
| Production reset screen | The signed-out launcher opened the [password reset form](production-password-reset.png). The signed-in phone-confirmation endpoint refused a signed-out request with HTTP 401. |
| Production database | Job `job-dc1f7qhksfps738ob6tg` confirmed the new verification purpose and the column that binds a challenge to its destination. |
| Staging browser | A newly signed-in test employee saw [the reminder](../../jira-comments/attachments/SCRUM-1067/staging-phone-verification-reminder.png). Do it later dismissed it through a reload. A new login showed it again. These actions sent zero messages. |
| Staged API image | Job `job-dc1eaut9fdbs73ak5560` passed all 12 staff-account checks in a disposable database with simulated SMS. These included recovery without a previous verification date, successful confirmation, rejection of invalid or reused codes, and updating only the matching linked HR number. |
| Staging cleanup | Job `job-dc1ef4mq1p3s7380a120` removed the test employee and access. The inactive audit identity retains no usable phone, password or session. |

The paid production sender confirmed delivery of the earlier approved Thai
test at 18:11 Bangkok. No employee reset SMS was sent for this release.

## Attendance and HR navigation in the same release

Production HR deployment `dep-dc1f80lg1s2s73d6vlkg` serves the same source.
A signed-in launcher session that opened the HR Check-ins page returned to
[the requested page](production-returned-to-checkins.png) and retained its query
after one handoff. An unverified administrator could defer the phone reminder
and continue into HR.

The two approved phone numbers resolve to the same active employment in
production (job `job-dc1f9lqfngtc73fgcgk0`). A registered test browser at
Central Floresta signed out, [clocked in](production-clocked-in.png) with
one number and [clocked out](production-clocked-out.png) with the other
on the synthetic employee. Cleanup job `job-dc1fb2942hec73a74sf0` verified
both events, both attempts and both photos, removed the fixture and confirmed
both photos were gone. The printed guest QR was unavailable for comparison.
