# SCRUM-1059 local pictures

Staff's copy of the drop-off form ("Private child details"), drawn by the
till's family form harness (`apps/pos/test/support/family-form-harness`,
`?screen=staff&finished=1`) from the source landed at 8a6f5fbc6.

- `staff-copy-1440x900.png`, `staff-copy-1024x768.png`,
  `staff-copy-768x1024.png`: the child whose parent ticked "may order food
  with the included credit" reads "Included credit" on the food choice
  (from `test/s1059-staff-copy-food-line.test.ts` with `FAMILYFORM_SHOTS`).
- `staff-copy-1440x900-not-ticked-after-finish.png`: once the family has
  finished the form, the child they left unticked reads "(not ticked by the
  family)", no longer "(the family ticks this on their screen)". Staging
  moves the till on as soon as the family's Done is accepted, so this state
  is pictured here; the phone row is cut from the picture.
