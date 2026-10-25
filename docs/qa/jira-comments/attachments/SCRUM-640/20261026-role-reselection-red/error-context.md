# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: roles.spec.ts >> the full permission catalogue and long park scopes remain usable on a phone
- Location: e2e\roles.spec.ts:114:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('list', { name: 'Permission holders', exact: true })
Expected substring: "ZZ TEST Chalong Family Adventure and Evening Operations Park — Reception and guest services team"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" getByRole('list', { name: 'Permission holders', exact: true }) with timeout 5000ms
  - waiting for getByRole('list', { name: 'Permission holders', exact: true })

```

```yaml
- banner:
  - button "Open navigation"
  - link "Admin home":
    - /url: /
    - text: OTO Admin
- main:
  - paragraph: Admin · People & access
  - heading "Roles & scopes" [level=1]
  - text: Existing roles in plain words, who holds a permission and previews before role changes.
  - link "Find an account":
    - /url: /people/accounts
  - heading "Role catalogue" [level=2]
  - text: what each existing role allows Search roles and permissions
  - textbox "Search roles and permissions":
    - /placeholder: Search roles or permissions…
  - group: operator_admin System role
  - heading "Who holds a permission?" [level=2]
  - text: people and scopes within your reach Permission
  - combobox "Permission":
    - option "Select the park group this session reads and changes while keeping the signed-in account unchanged." [selected]
    - option "Read today's summary figures for the parks you can reach."
    - option "View employee salary and pay details in the OTO App when platform access is enabled."
    - option "Invite a staff sign-in account with an allowed role and scope."
    - option "Read staff sign-in accounts, their sessions and their shift tokens."
    - option "Manage account status, phone numbers, temporary passwords and sign-outs."
    - option "Read roles, role grants and effective permissions."
    - option "Add or remove allowed role grants and manage app access."
    - option "Create a park group on the platform."
    - option "Read park groups on the platform."
    - option "Change a park group on the platform."
    - option "Be recognised as administering the whole operator, without adding other permissions."
    - option "Create a park within the park group."
    - option "Read park details within the park group."
    - option "Change park details within the park group."
    - option "Read the activity history with sensitive details masked."
    - option "Read unmasked activity details, including child health notes, phone numbers and terminal data."
    - option "Read station setup, assigned staff, devices and payment routing."
    - option "Create a station and its setup."
    - option "Change station setup, assigned staff, devices and payment routing."
    - option "Archive a station so it is no longer available for use."
    - option "Read box details and reported status."
    - option "Register a box to run park stations."
    - option "Change the details of a registered box."
    - option "Send box commands such as test print, restart, collect logs or reset storage."
    - option "Archive a box so it is no longer available for use."
    - option "Read the devices connected to a box."
    - option "Add a device to a box."
    - option "Change the setup of a connected device."
    - option "Archive a connected device from active use."
    - option "Create a pairing code for a display, kiosk or booth."
    - option "Revoke a paired device credential."
    - option "Read booth setup, prizes, staff and results."
    - option "Manage booth drafts, wheel designs, prizes, voucher types and campaigns."
    - option "Publish a configuration version for booths to use."
    - option "Choose which staff may work at each booth."
    - option "Sign in to work at a booth where you are also assigned as staff."
    - option "Read platform health, failures and integration status."
    - option "Retry failed runs, acknowledge alerts and resolve operational expectations."
    - option "Look up one member and their details at the counter."
    - option "Browse the member register, including guardian phone numbers."
    - option "Register a new member at the counter."
    - option "Change a member's details at the counter."
    - option "Move a member to a lower membership tier."
    - option "Read child details at the counter."
    - option "Add a child to a member record."
    - option "Change a child's details at the counter."
    - option "Create a park visit at the counter."
    - option "Read the details of a park visit."
    - option "Change the details of a park visit."
    - option "Read the list of families expected on an online booking."
    - option "Claim a paid online booking at the counter."
    - option "Take over a station while another till still holds its live lease."
    - option "Read sales and their order details."
    - option "Start a sale at the till."
    - option "Change the items on a sale."
    - option "Apply a manual sale discount with a reason."
    - option "Void a sale subject to its payment and approval checks."
    - option "Read payments and their recorded status."
    - option "Take a payment for a sale."
    - option "Confirm an unresolved payment attempt from a terminal or gateway."
    - option "Void a payment subject to its payment and approval checks."
    - option "Run payment settlement and import gateway settlement reports."
    - option "Read refunds and their recorded status."
    - option "Request a refund for a sale."
    - option "Approve refunds and voids after payment."
    - option "Redeem a voucher presented at the counter."
    - option "Read print jobs and their status."
    - option "Print a receipt for a sale."
    - option "Print a wristband for a visit."
    - option "Print a voucher for a customer."
    - option "Print another copy using the original code."
    - option "Read drawer records and End of Day figures."
    - option "Open a cash drawer session."
    - option "Close a cash drawer session."
    - option "Record cash paid in, paid out or moved to the safe."
    - option "Countersign a paid-out, safe drop, close variance or day close with people still counted inside."
    - option "Close the trading day, resolve people still counted inside and reprint its End of Day receipt."
    - option "Read child supervision registrations, stays and guardian details."
    - option "Register a child for supervision."
    - option "Manage supervision stays, care notes, confirmations and parent contact records."
    - option "Release a supervised child through the approved collection checks."
    - option "Manage the guardians authorised to collect a supervised child."
    - option "Read events and rosters, including child allergy notes and parent phone numbers."
    - option "Add a child to a free event or a party tab without taking payment at the door."
    - option "Sell a paid camp or event pass and add the child to its roster."
    - option "Add tickets or food and drink charges to a party tab."
    - option "Take a payment against a party's outstanding balance."
    - option "Change a party's details in the OTO App."
    - option "Check children in or out of events and print or reprint their bands."
    - option "Change camp day, event day and party guest walk-up prices."
    - option "Read member wallets and their credit history."
    - option "Grant credit to a member's wallet."
    - option "Spend available wallet credit on a sale."
    - option "Make a correction to wallet credit."
    - option "Reactivate expired wallet credit with a typed reason."
    - option "Read stock items, levels and movements."
    - option "Correct stock quantities and manage stock items, sizes, packs and places."
    - option "Move stock between places within a park."
    - option "Record a stock count at a park."
    - option "Receive deliveries into park stock."
    - option "Read stock costs and manage purchase orders."
    - option "Approve a stock count variance above the park's tolerance."
    - option "Read ticket packages and membership tiers."
    - option "Create ticket packages or membership tiers and copy a branch catalogue."
    - option "Change ticket packages, membership tiers, drop-off prices and supervision rules."
    - option "Read the park holiday calendar."
    - option "Change the park holiday calendar."
    - option "Read tax rates and rules for sales."
    - option "Change tax rates and rules for sales."
    - option "Read menu items, merchandise and discount codes."
    - option "Manage menu items, merchandise, categories, modifiers and discount codes."
    - option "Import menu records from a spreadsheet."
    - option "Apply a staff benefit at the food and drink till."
    - option "Read staff benefit templates, assignments and history."
    - option "Change benefit templates, assign benefit roles and set a person's override."
    - option "Issue, revoke or print a staff benefit code."
    - option "Read revenue, guest counts and other park analytics."
    - option "Read Inbox team lists, conversations and their dashboard."
    - option "Send a reply in an Inbox conversation you can read."
    - option "Change primary and support staff or divert conversations on another person's behalf."
    - option "Move an Inbox conversation to another team, including across parks."
    - option "Mark an Inbox conversation as handled."
    - option "Reopen an Inbox conversation by hand."
    - option "Manage templates for Inbox replies."
    - option "Manage Inbox channel accounts and the simulator."
    - option "Read the Inbox dashboard metric cards."
    - option "Choose the default primary and backup staff by enquiry category and language."
    - option "Permanently erase an Inbox contact under the privacy erasure rules."
    - option "Draft, approve or archive customer assistant knowledge and approve example replies."
    - option "Switch a channel assistant off or into shadow or live mode."
    - option "Ask the internal assistant using only information and actions your existing access allows."
    - option "Read other people's assistant questions and the correction list."
    - option "Open the till app, with actions still controlled by their own permissions."
    - option "Open Admin, with actions still controlled by their own permissions."
    - option "Open the OTO App, with actions still controlled by their own permissions."
    - option "Open Radar, with actions still controlled by their own permissions."
    - option "Open the booth app, with actions still controlled by their own permissions."
    - option "Open Inbox, with actions still controlled by their own permissions."
  - paragraph: Pick a permission to see the accounts and role assignments that give it to them.
  - paragraph: Loading permission holders…
  - region "Notifications (F8)":
    - list
```

# Test source

```ts
  35  |     return { sessionId: fixtureSessionId, homeOperatorId: operatorId, effectiveOperatorId: operatorId,
  36  |       operatorOverride: null, branchId, stationId: null, revision: 0 };
  37  |   };
  38  |
  39  |   const writes: Array<{ method: string; path: string; body: unknown; key: string | undefined }> = [];
  40  |   const previews: URLSearchParams[] = [];
  41  |   let granted = false;
  42  |   await page.route('**/api/**', async (route) => {
  43  |     const request = route.request();
  44  |     const url = new URL(request.url());
  45  |     const path = url.pathname.replace(/^\/api/, '');
  46  |     if (path === '/me') return route.fulfill({ json: {
  47  |       operatorContext: fixtureOperatorContext('01964000-0000-7000-8000-00000000f111', OPERATOR, null),
  48  |       account: { id: '01964000-0000-7000-8000-00000000f111', phone: '', status: 'active', mustChangePassword: false, operatorId: OPERATOR },
  49  |       employee: { id: '01964000-0000-7000-8000-00000000f111', name: 'ZZ TEST Admin', nickname: null }, branch: null,
  50  |       isPlatformAdmin: options.platform ?? false, photoFileId: null, sessionLocked: false,
  51  |     } });
  52  |     if (path === '/me/permissions') return route.fulfill({ json: { permissions: [
  53  |       'app:console:access', 'admin:account:read', ...(options.read === false ? [] : ['admin:role:read']),
  54  |       ...(options.assign === false ? [] : ['admin:role:assign']),
  55  |     ].map((permission) => ({ permission, scopeType: 'operator', scopeId: OPERATOR })) } });
  56  |     if (path === '/branches') return route.fulfill({ json: { branches: [
  57  |       { id: BRANCH, name: 'ZZ TEST Park', code: 'ZZ', timezone: 'Asia/Bangkok', archived: false },
  58  |     ] } });
  59  |     if (path === '/accounts') return route.fulfill({ json: { accounts: [account(), account(MAI)] } });
  60  |     if (path === '/roles' || path === '/roles/') return route.fulfill({ json: catalogue });
  61  |     if (path === '/roles/holders') return route.fulfill({ json: {
  62  |       permission: url.searchParams.get('permission'), words: sales.words,
  63  |       holders: url.searchParams.get('permission') === refunds.permission ? [] : [{
  64  |         accountId: SOM, phone: account().phone, status: 'active', employee: account().employee,
  65  |         assignments: [{ id: ASSIGNMENT, roleName: 'reception', scopeType: 'branch', scopeId: BRANCH, scopeName: 'ZZ TEST Park' }],
  66  |       }],
  67  |     } });
  68  |     if (path === '/roles/preview') {
  69  |       previews.push(url.searchParams);
  70  |       return route.fulfill({ json: preview(url.searchParams) });
  71  |     }
  72  |     if (path.endsWith('/permissions')) return route.fulfill({ json: {
  73  |       assignments: [{ id: ASSIGNMENT, roleName: 'reception', scopeType: 'branch', scopeId: BRANCH },
  74  |         ...(granted ? [{ id: ADDED, roleName: 'staff', scopeType: 'branch', scopeId: BRANCH }] : [])],
  75  |       effective: [{ permission: path.includes(MAI) ? refunds.permission : sales.permission, scopeType: 'branch', scopeId: BRANCH, roleName: 'reception' }],
  76  |     } });
  77  |     if (path.includes('/role-assignments')) {
  78  |       writes.push({ method: request.method(), path, body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
  79  |       granted = request.method() === 'POST';
  80  |       return route.fulfill({ json: granted ? { id: ADDED } : { ok: true } });
  81  |     }
  82  |     return route.fulfill({ status: 403, json: { error: { code: 'PERMISSION_DENIED', message: 'Not on this fixture’s access.' } } });
  83  |   });
  84  |   return { writes, previews };
  85  | }
  86  |
  87  | async function permissionsForSom(page: Page) {
  88  |   await page.goto('/people/accounts');
  89  |   await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Effective permissions', { exact: true }).click();
  90  |   const dialog = page.getByRole('dialog', { name: 'Permissions — ZZ TEST Som', exact: true });
  91  |   await expect(dialog.getByText('pos:sale:read', { exact: true })).toBeVisible();
  92  |   return dialog;
  93  | }
  94  |
  95  | test('the role catalogue speaks in sentences and reverse lookup shows the server’s visible people and scopes', async ({ page }, testInfo) => {
  96  |   await fixture(page);
  97  |   await page.goto('/people/roles');
  98  |   await expect(page.getByRole('heading', { name: 'Roles & scopes', exact: true })).toBeVisible();
  99  |   await page.locator('summary').filter({ hasText: 'reception' }).click();
  100 |   await expect(page.getByText(sales.words, { exact: true }).first()).toBeVisible();
  101 |   const holders = page.getByRole('list', { name: 'Permission holders', exact: true });
  102 |   await expect(holders).toContainText('ZZ TEST Som');
  103 |   await expect(holders).toContainText('ZZ TEST Park');
  104 |   await page.screenshot({ path: testInfo.outputPath('roles-desktop.png'), fullPage: true, animations: 'disabled' });
  105 |   await page.getByRole('combobox', { name: 'Permission', exact: true }).selectOption(refunds.permission);
  106 |   await expect(page.getByText('No holders in your reach', { exact: true })).toBeVisible();
  107 |   await page.setViewportSize({ width: 390, height: 844 });
  108 |   await page.getByRole('combobox', { name: 'Permission', exact: true }).selectOption(sales.permission);
  109 |   await expect(holders).toContainText('ZZ TEST Som');
  110 |   await page.screenshot({ path: testInfo.outputPath('roles-phone.png'), fullPage: true, animations: 'disabled' });
  111 |   expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  112 | });
  113 |
  114 | test('the full permission catalogue and long park scopes remain usable on a phone', async ({ page }, testInfo) => {
  115 |   await fixture(page);
  116 |   const permissions = Object.entries(PERMISSION_WORDS).map(([permission, words]) => ({ permission, words }));
  117 |   const longest = permissions.reduce((held, entry) => entry.words.length > held.words.length ? entry : held);
  118 |   const scopeName = 'ZZ TEST Chalong Family Adventure and Evening Operations Park — Reception and guest services team';
  119 |   await page.route('**/api/roles', (route) => route.fulfill({ json: {
  120 |     permissions,
  121 |     roles: [{ id: 'operator_admin', name: 'operator_admin', description: 'The existing operator administrator role.', system: true, permissions }],
  122 |   } }));
  123 |   await page.route('**/api/roles/holders*', (route) => route.fulfill({ json: {
  124 |     permission: new URL(route.request().url()).searchParams.get('permission'), words: longest.words,
  125 |     holders: [{ accountId: SOM, phone: account().phone, status: 'active', employee: account().employee,
  126 |       assignments: [{ id: ASSIGNMENT, roleName: 'branch_manager', scopeType: 'branch', scopeId: BRANCH, scopeName }] }],
  127 |   } }));
  128 |   await page.setViewportSize({ width: 390, height: 844 });
  129 |   await page.goto('/people/roles');
  130 |   const picker = page.getByRole('combobox', { name: 'Permission', exact: true });
  131 |   await expect(picker.getByRole('option')).toHaveCount(PERMISSIONS.length);
  132 |   await expect(picker.locator('option[value="platform:operator:switch"]')).toHaveText(PERMISSION_WORDS['platform:operator:switch']);
  133 |   await picker.selectOption(longest.permission);
  134 |   await expect(picker).toHaveValue(longest.permission);
> 135 |   await expect(page.getByRole('list', { name: 'Permission holders', exact: true })).toContainText(scopeName);
      |                                                                                     ^ Error: expect(locator).toContainText(expected) failed
  136 |   await page.locator('summary').filter({ hasText: 'operator_admin' }).click();
  137 |   await expect(page.getByText(longest.words, { exact: true }).first()).toBeVisible();
  138 |   expect(await page.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth })))
  139 |     .toEqual({ width: 390, contentWidth: 390 });
  140 |   const box = await picker.boundingBox();
  141 |   expect(box).not.toBeNull();
  142 |   expect(box!.x).toBeGreaterThanOrEqual(0);
  143 |   expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  144 |   await picker.scrollIntoViewIfNeeded();
  145 |   await page.screenshot({ path: testInfo.outputPath('roles-full-catalogue-phone.png'), animations: 'disabled' });
  146 | });
  147 |
  148 | test('the lifted branch grant and removal both require canonical previews before writing', async ({ page }, testInfo) => {
  149 |   const { writes, previews } = await fixture(page);
  150 |   const dialog = await permissionsForSom(page);
  151 |   await expect(dialog.getByRole('combobox', { name: 'Role', exact: true }).getByRole('option')).toHaveText(['reception', 'staff', 'branch_manager', 'operator_admin']);
  152 |   await expect(dialog.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('operator');
  153 |   await expect(dialog.getByRole('option', { name: 'Platform-wide (every operator)', exact: true })).toHaveCount(0);
  154 |   await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('staff');
  155 |   await dialog.getByRole('combobox', { name: 'Scope', exact: true }).selectOption(`branch:${BRANCH}`);
  156 |   await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  157 |   const review = page.getByRole('alertdialog', { name: 'Review permission change', exact: true });
  158 |   await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  159 |   expect(writes).toHaveLength(0);
  160 |   await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  161 |   expect(writes).toHaveLength(0);
  162 |   await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  163 |   await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  164 |   await page.screenshot({ path: testInfo.outputPath('role-preview.png'), animations: 'disabled' });
  165 |   expect(await pressLandsOn(review.getByRole('button', { name: 'Save role change', exact: true }))).toContain('button “Save role change”');
  166 |   await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  167 |   await expect(review).toHaveCount(0);
  168 |   expect(writes[0]).toMatchObject({ method: 'POST', path: `/accounts/${SOM}/role-assignments`,
  169 |     body: { roleName: 'staff', scopeType: 'branch', scopeId: BRANCH } });
  170 |   expect(writes[0]?.key).toBeTruthy();
  171 |   expect(previews[0]?.get('scopeId')).toBe(BRANCH);
  172 |   await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(2);
  173 |   await dialog.getByRole('button', { name: 'Remove', exact: true }).last().click();
  174 |   await expect(review.getByRole('heading', { name: 'Removed access (1)', exact: true })).toBeVisible();
  175 |   await review.getByRole('button', { name: 'Save role change', exact: true }).click();
  176 |   await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1);
  177 |   expect(writes[1]).toMatchObject({ method: 'DELETE', path: `/accounts/${SOM}/role-assignments/${ADDED}` });
  178 |   expect(previews.at(-1)?.get('assignmentId')).toBe(ADDED);
  179 | });
  180 |
  181 | test('a refused or pending preview cannot save a role change', async ({ page }) => {
  182 |   const { writes } = await fixture(page);
  183 |   let release: (() => void) | undefined;
  184 |   const pending = new Promise<void>((resolve) => { release = resolve; });
  185 |   await page.route('**/api/roles/preview*', async (route) => {
  186 |     await pending;
  187 |     return route.fulfill({ status: 403, json: { error: { code: 'LAST_ADMIN', message: 'The last administrator must keep this role.' } } });
  188 |   });
  189 |   const dialog = await permissionsForSom(page);
  190 |   await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  191 |   const review = page.getByRole('alertdialog');
  192 |   await expect(review.getByRole('button', { name: 'Save role change', exact: true })).toBeDisabled();
  193 |   release!();
  194 |   await expect(review.getByRole('alert')).toContainText('The last administrator must keep this role.');
  195 |   await expect(review.getByRole('button', { name: 'Save role change', exact: true })).toBeDisabled();
  196 |   expect(writes).toHaveLength(0);
  197 | });
  198 |
  199 | test('an earlier account permission read cannot replace a different account’s drawer', async ({ page }) => {
  200 |   await fixture(page);
  201 |   let release: (() => void) | undefined;
  202 |   const pending = new Promise<void>((resolve) => { release = resolve; });
  203 |   await page.route(`**/api/accounts/${SOM}/permissions`, async (route) => { await pending; return route.fulfill({ json: {
  204 |     assignments: [], effective: [{ permission: sales.permission, scopeType: 'branch', scopeId: BRANCH, roleName: 'reception' }],
  205 |   } }); });
  206 |   await page.goto('/people/accounts');
  207 |   await page.getByRole('row', { name: /ZZ TEST Som/ }).getByTitle('Effective permissions', { exact: true }).click();
  208 |   await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  209 |   await page.getByRole('row', { name: /ZZ TEST Mai/ }).getByTitle('Effective permissions', { exact: true }).click();
  210 |   const mai = page.getByRole('dialog', { name: 'Permissions — ZZ TEST Mai', exact: true });
  211 |   await expect(mai.getByText(refunds.permission, { exact: true })).toBeVisible();
  212 |   const response = page.waitForResponse(`**/api/accounts/${SOM}/permissions`);
  213 |   release!(); await response; await page.waitForLoadState('networkidle');
  214 |   await expect(mai.getByText(refunds.permission, { exact: true })).toBeVisible();
  215 |   await expect(mai.getByText(sales.permission, { exact: true })).toHaveCount(0);
  216 | });
  217 |
  218 | test('a canceled earlier preview cannot authorize a new scope choice', async ({ page }) => {
  219 |   const { writes } = await fixture(page);
  220 |   let release: (() => void) | undefined;
  221 |   const pending = new Promise<void>((resolve) => { release = resolve; });
  222 |   await page.route('**/api/roles/preview*', async (route) => {
  223 |     const query = new URL(route.request().url()).searchParams;
  224 |     if (query.get('scopeType') !== 'operator') return route.fallback();
  225 |     await pending;
  226 |     return route.fulfill({ json: { ...preview(query), added: [point(sales, 'operator', OPERATOR)] } });
  227 |   });
  228 |   const dialog = await permissionsForSom(page);
  229 |   await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  230 |   const review = page.getByRole('alertdialog');
  231 |   await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  232 |   await dialog.getByRole('combobox', { name: 'Scope', exact: true }).selectOption(`branch:${BRANCH}`);
  233 |   await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  234 |   await expect(review.getByText(refunds.words, { exact: true })).toBeVisible();
  235 |   const response = page.waitForResponse((answer) => new URL(answer.url()).searchParams.get('scopeType') === 'operator');
```
