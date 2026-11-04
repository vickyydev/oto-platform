# SCRUM-729 staging proof: the customer display labels follow the display language

Run on 4 November 2026 between 07:43 and 07:51 Bangkok on live commit
690d44dbfa31d8a3c487dfb3def0be9dfa3e105c, in the POS at oto-pos-web-staging, in a real browser.
The fixtures were made for this proof: till "ZZ TEST SCRUM-729 mw1e5qd4 till" on
Virtual box 1 at Central Floresta, one ZZ TEST dish in its own ZZ TEST category, and,
for the idle display, a second till that nobody opened. No payment was taken, no sale
was written and no SMS was sent. The Pi, its two tills and FWBooth1 were not used.

| Step in the lane's proof plan | Result | Evidence |
|---|---|---|
| 1. Ticket with kids and adults on the till, breakdown and tax row on the display | Pass: 1 Hour Play, 2 kids, 2 adults | `s729-01-english-before.png` |
| 2. Russian: Дети, Взрослые, Включая НДС; staff screen still Kids, Adults, VAT included | Pass | `s729-02-russian-display-english-staff.png` |
| 3. Thai: เด็ก, ผู้ใหญ่, รวมภาษีมูลค่าเพิ่ม; staff screen still English | Pass | `s729-03-thai-display-english-staff.png` |
| 4. English again: same words as before | Pass (display text identical) | `s729-04-english-after.png` |
| 5. F&B in Russian: per-unit line and tax row | Pass: "฿50 за шт. × 2", Включая НДС | `s729-05-fnb-russian-per-unit-and-tax.png` |
| 5. Shop in Russian | Not shown. The only ZZ TEST shop item on staging (ZZ TEST Stock 496 Mug) belongs to an earlier check, and this proof used only its own records. | `staging-fixture.json` (`cleanup.zzShopItems`) |
| 6. Paired /display in Russian, till idle: "Добро пожаловать в OTO Park" | Pass | `s729-08-paired-display-idle-russian.png` |
| 6. Pairing screen stays English | Pass (code blanked) | `s729-06-display-pairing-stays-english.png` |

How step 6 was reached: Russian was chosen on the paired screen's own button while it
was paired to the ZZ TEST till at Membership Check (`s729-07`). Locking the staff
screen leaves the visitor's prompt in place by design, so the screen stayed on that
prompt. The same screen was then paired to a second ZZ TEST till that nobody had
opened, and showed its idle greeting in the language it remembered.

Proof tooling note: the first paired-display run revoked its display credential while
the staff screen was locked, and the API refused it (HTTP 423, the locked session).
The credential was revoked one minute later from a Console session (`s729-revoke`).
The later run revoked its credentials from an unlocked session. All three ZZ display
pairings are revoked, and neither till lists a display.

Cleanup read back (`staging-fixture.json`, `cleanup`): both ZZ tills are archived, the
dish and category are archived and missing from the active menu, and both tills
have 0 sales. Till 1 (Pi), Till 2 (test) and FWBooth1 are unchanged.

Jira: the images are attached to SCRUM-729 and shown inside comment 13376
(`jira-publication.json`, wording in `jira-proof-comment.txt`). `jira.mjs walk`
moved the ticket to Deployed and linked 3 commits. A fresh read confirms Deployed.
