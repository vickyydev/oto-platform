# SCRUM-464: In-app notification tenant scope

The notification bell already lists in-app task notifications, shows the unread count, marks one or all read, and opens the related task. Those routes previously used only the recipient account ID. A platform account linked to more than one tenant could therefore see or change another tenant's notifications.

List, unread count, mark-one-read and mark-all-read now require the tenant resolved by sign-on and filter by both tenant and recipient. An absent tenant fails closed. Marking a notification outside that scope returns not-found. Pagination rejects fractional or unsafe values. This slice covers existing in-app notifications; delivery pending/delivered/failed states are the later S2-17c feature.

The production build passed. App typecheck remains at 542 inherited errors with none in the changed notification route area, and scoped ESLint is clear. No existing notification test file exists. Commit `32d69b3a` deployed to oto-app-staging as `dep-dau7t1uk1f9s73anm07g`. Health returned 200 and anonymous list, count, mark-one and mark-all requests returned 401. Signed-in staging checks need two tenant contexts and a notification to verify list/count/read isolation and the task link. A named screenshot is required before Deployed.
