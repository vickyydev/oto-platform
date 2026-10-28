# Frontend page inventory

Static inventory only. Findings and runtime coverage are recorded separately. All aliases are retained.

| Page | Paths | Permission | Component | Source |
| --- | --- | --- | --- | --- |
| Analytics & sources | /reports/analytics, /analytics | console:analytics:read | <AnalyticsSources /> | apps/console/src/pages/AnalyticsSources.tsx (registration App.tsx:153) |
| Configuration | /organisation/configuration, /config | console:config:read | <Configuration /> | apps/console/src/pages/Configuration.tsx (registration App.tsx:154) |
| Apps | /organisation/apps, /apps | console:app_registry:read | <SuiteControls page="apps" /> | apps/console/src/pages/SuiteControls.tsx (registration App.tsx:155) |
| Releases | /watch/releases, /releases | console:release:read | <SuiteControls page="releases" /> | apps/console/src/pages/SuiteControls.tsx (registration App.tsx:156) |
| Support | /watch/support, /support | console:support:lookup | <Support /> | apps/console/src/pages/Support.tsx (registration App.tsx:202) |
| Inventory | /catalogue/inventory, /inventory | Inherited local offer; API authority | <Operations page="inventory" /> | apps/console/src/pages/Operations.tsx (registration App.tsx:163) |
| Members | /catalogue/members, /members | pos:member:update | <Operations page="members" /> | apps/console/src/pages/Operations.tsx (registration App.tsx:164) |
| Tier verifications | /catalogue/tier-verifications, /tier-verifications | pos:member:read | <Operations page="tier-verifications" /> | apps/console/src/pages/Operations.tsx (registration App.tsx:165) |
| Wallets | /reports/wallets, /wallets | pos:wallet:read | <Operations page="wallets" /> | apps/console/src/pages/Operations.tsx (registration App.tsx:166) |
| Teams & routing | /channels/teams-routing, /teams-routing | inbox:routing:manage | <TeamsRouting /> | apps/console/src/pages/TeamsRouting.tsx (registration App.tsx:167) |
| Assistant settings | /channels/assistant-settings, /assistant-settings | inbox:ai:manage | <AssistantSettings /> | apps/console/src/pages/AssistantSettings.tsx (registration App.tsx:168) |
| Sales | /reports/sales, /reports-sales | analytics:read | <Reports page="sales" /> | apps/console/src/pages/Reports.tsx (registration App.tsx:169) |
| Profitability | /reports/profitability, /reports-profitability | analytics:read | <Reports page="profitability" /> | apps/console/src/pages/Reports.tsx (registration App.tsx:170) |
| Discounts & comps | /reports/discounts, /reports-discounts | analytics:read | <Reports page="discounts" /> | apps/console/src/pages/Reports.tsx (registration App.tsx:171) |
| Tax & VAT | /reports/tax-vat, /reports-tax-vat | analytics:read | <Reports page="tax-vat" /> | apps/console/src/pages/Reports.tsx (registration App.tsx:172) |
| Wallet & promo | /reports/wallet-promo, /reports-wallet-promo | analytics:read | <Reports page="wallet-promo" /> | apps/console/src/pages/Reports.tsx (registration App.tsx:173) |
| Money oversight | /reports/money, /money | console:money:read | <MoneyOversight /> | apps/console/src/pages/MoneyOversight.tsx (registration App.tsx:177) |
| Drop-off & supervision | /catalogue/care, /care | pos:checkin:read | <Care page="care" /> | apps/console/src/pages/Care.tsx (registration App.tsx:174) |
| Print templates | /catalogue/print-templates, /print-templates | pos:print:read | <Care page="print-templates" /> | apps/console/src/pages/Care.tsx (registration App.tsx:175) |
| Staff benefits | /catalogue/staff-benefits, /staff-benefits | admin:benefit:read | <StaffBenefits /> | apps/console/src/pages/StaffBenefits.tsx (registration App.tsx:176) |
| Discounts | /catalogue/discounts, /discounts | catalog:menu:manage | <Money page="discounts" /> | apps/console/src/pages/Money.tsx (registration App.tsx:178) |
| Tenders | /catalogue/tenders, /tenders | catalog:menu:manage | <Money page="tenders" /> | apps/console/src/pages/Money.tsx (registration App.tsx:179) |
| Tax | /catalogue/tax, /tax | catalog:tax:manage | <Money page="tax" /> | apps/console/src/pages/Money.tsx (registration App.tsx:180) |
| Voucher campaigns | /catalogue/voucher-campaigns, /voucher-campaigns | admin:booth:read | <Money page="voucher-campaigns" /> | apps/console/src/pages/Money.tsx (registration App.tsx:181) |
| Event pricing | /catalogue/event-pricing, /event-pricing | admin:event_pricing:manage | <Money page="event-pricing" /> | apps/console/src/pages/Money.tsx (registration App.tsx:182) |
| Menu | /catalogue/menu, /menu | catalog:menu:read | <MenuCatalogue page="menu" /> | apps/console/src/pages/MenuCatalogue.tsx (registration App.tsx:183) |
| Categories | /catalogue/categories, /categories | catalog:menu:read | <MenuCatalogue page="categories" /> | apps/console/src/pages/MenuCatalogue.tsx (registration App.tsx:184) |
| Modifiers | /catalogue/modifiers, /modifiers | catalog:menu:read | <MenuCatalogue page="modifiers" /> | apps/console/src/pages/MenuCatalogue.tsx (registration App.tsx:185) |
| Merch | /catalogue/merch, /merch | catalog:menu:read | <MenuCatalogue page="merch" /> | apps/console/src/pages/MenuCatalogue.tsx (registration App.tsx:186) |
| Tickets | /catalogue/tickets, /tickets | catalog:package:read | <Catalogue page="tickets" /> | apps/console/src/pages/Catalogue.tsx (registration App.tsx:187) |
| Tiers | /catalogue/tiers, /tiers | catalog:package:read | <Catalogue page="tiers" /> | apps/console/src/pages/Catalogue.tsx (registration App.tsx:188) |
| Add-ons | /catalogue/add-ons, /add-ons | catalog:menu:read | <Catalogue page="add-ons" /> | apps/console/src/pages/Catalogue.tsx (registration App.tsx:189) |
| Operators | /organisation/operators, /operators | admin:operator:read +platform-wide | <Operators /> | apps/console/src/pages/Operators.tsx (registration App.tsx:190) |
| Operators | /platform/operators, /platform-operators | admin:operator:read +platform-wide | <Operators sectionId="platform-operators" /> | apps/console/src/pages/Operators.tsx (registration App.tsx:157) |
| System roles | /platform/system-roles, /system-roles | admin:role:read +platform-wide | <Platform page="system-roles" /> | apps/console/src/pages/Platform.tsx (registration App.tsx:158) |
| Platform alerts | /platform/alerts, /platform-alerts | admin:health:read +platform-wide | <Platform page="platform-alerts" /> | apps/console/src/pages/Platform.tsx (registration App.tsx:159) |
| Platform jobs | /platform/jobs, /platform-jobs | admin:health:read +platform-wide | <Platform page="platform-jobs" /> | apps/console/src/pages/Platform.tsx (registration App.tsx:160) |
| Environment | /platform/environment, /platform-environment | admin:health:read +platform-wide | <Platform page="platform-environment" /> | apps/console/src/pages/Platform.tsx (registration App.tsx:161) |
| Test controls | /platform/test-controls, /platform-test-controls | admin:ops:manage +platform-wide | <Platform page="platform-test-controls" /> | apps/console/src/pages/Platform.tsx (registration App.tsx:162) |
| Holidays | /organisation/holidays, /holidays | catalog:holiday:manage | <Holidays /> | apps/console/src/pages/Holidays.tsx (registration App.tsx:191) |
| Access review | /people/access-review, /access-review | admin:role:read | <AccessReview /> | apps/console/src/pages/AccessReview.tsx (registration App.tsx:197) |
| Departments | /people/departments, /departments | admin:account:read | <Departments /> | apps/console/src/pages/Departments.tsx (registration App.tsx:196) |
| Employees | /people/employees, /employees | admin:account:read | <Employees /> | apps/console/src/pages/Employees.tsx (registration App.tsx:195) |
| App access | /people/app-access, /app-access | admin:account:read | <AppAccess /> | apps/console/src/pages/AppAccess.tsx (registration App.tsx:194) |
| Roles & scopes | /people/roles, /roles | admin:role:read | <Roles /> | apps/console/src/pages/Roles.tsx (registration App.tsx:193) |
| Accounts | /people/accounts, /accounts | admin:account:read | <Accounts /> | apps/console/src/pages/Accounts.tsx (registration App.tsx:192) |
| Health | /watch/health, /health | admin:health:read | <Health /> | apps/console/src/pages/Health.tsx (registration App.tsx:198) |
| Failures | /watch/failures, /failures | admin:health:read | <Failures /> | apps/console/src/pages/Failures.tsx (registration App.tsx:198) |
| Activity | /watch/activity, /activity | admin:audit:read | <Activity /> | apps/console/src/pages/Activity.tsx (registration App.tsx:198) |
| Booths | /devices/booths, /booths | admin:booth:read | <Booths /> | apps/console/src/pages/Booths.tsx (registration App.tsx:200) |
| Booth report | /reports/booths, /booth-report | analytics:read | <BoothReport /> | apps/console/src/pages/BoothReport.tsx (registration App.tsx:200) |
| Devices | /devices | admin:station:read | <Devices /> | apps/console/src/pages/Devices.tsx (registration App.tsx:199) |
| Branches | /organisation/branches, /branches | admin:branch:read | <Branches /> | apps/console/src/pages/Branches.tsx (registration App.tsx:199) |
| Bookings | /reports/bookings, /bookings | pos:booking:read | <Bookings /> | apps/console/src/pages/Bookings.tsx (registration App.tsx:199) |
| Vouchers | /catalogue/vouchers, /vouchers | admin:booth:read | <Vouchers /> | apps/console/src/pages/Vouchers.tsx (registration App.tsx:200) |
| Voucher types | /catalogue/voucher-types, /voucher-types | admin:booth:read | <VoucherTypes /> | apps/console/src/pages/VoucherTypes.tsx (registration App.tsx:201) |
| Integrations | /watch/integrations, /integrations | admin:health:read | <Integrations /> | apps/console/src/pages/Integrations.tsx (registration App.tsx:201) |
