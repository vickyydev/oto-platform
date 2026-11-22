# Production employee clock

The original three attempts stored a photo and failed employee identification. The
clock searched the standardized employee phone field. All 61 active employees
had a contact number and all 61 clock fields were empty.

The first repair set 58 unambiguous numbers. An independent read found the
number used in the park video on exactly one active employee. A second repair
matched the name, email and phone on a former and current employment and set
only the current profile. For another employee, the contact and linked login
both had the same extra Thai trunk zero after the country code. Only the clock
field was normalized. Production then had 60 populated clock fields for 61
active employees. The remaining contact and login carry different numbers.

On the production HR release at 63e9f5b628f8bb09ec9690fc76d4e5379017f470, an
administrator registered a temporary Central Floresta browser. After both
sessions returned 401, the synthetic employee recorded IN and OUT using the
phone keypad and separate simulated photos. Readback confirmed both records
and both successful attempts. The test employee, temporary tablet, two events,
two attempts and both photos were removed and their absence checked. No real
attendance was reconstructed or corrected.

## Permanent repair

Source 81c7642abbc2ea9b0739d045a8d4e36f6b9e3125 passed all six jobs in
[the release run](https://github.com/vickyydev/oto-platform/actions/runs/45005390236).
Staging deployment dep-dc1bg4l6e07s73cte3n0 and production HR deployment
dep-dc1bind6e07s73ctk9k0 each returned that source to a signed-in administrator.
On both databases a test import populated the clock number, a contact edit
replaced it, and clearing the contact removed it. Each transaction was
rolled back and the employee's absence verified independently.

A second production employee was created with only a contact number. From a
signed-out Central Floresta tablet test browser it recorded [IN](release-clocked-in.png)
and [OUT](release-clocked-out.png). Database readback linked each event to the
test employee, tablet, and a distinct photo. After verification, the two events,
two attempts, both photos, tablet and employee were removed and checked absent.
The local employment access suite also checked that two currently eligible
employees sharing a number cannot use that number to punch for either one.

All six branch jobs passed before landing. In the [repeat main run](https://github.com/vickyydev/oto-platform/actions/runs/45008509623),
the third API shard compared print template rows in an unspecified database
order. Its 26-test file passed in full on the same source locally. The failed
shard was submitted for one retry. The HR app job passed on both runs.
