set -eo pipefail
pnpm --filter @oto/api exec tsx C:/oto-lanes/s747-api-gate.mts test/s747-till-code-review.test.ts test/payments-2c2p.test.ts test/booking-checkout.test.ts test/fleet-api.test.ts > C:/oto-lanes/s747-api-focused.log 2>&1
pnpm --filter @oto/api exec tsc -p tsconfig.json > C:/oto-lanes/s747-api-types.log 2>&1
pnpm --filter @oto/pos typecheck > C:/oto-lanes/s747-pos-types.log 2>&1
pnpm --filter @oto/shared typecheck > C:/oto-lanes/s747-shared-types.log 2>&1
pnpm exec eslint packages/shared/src/payments.ts packages/shared/test/payments.test.ts packages/shared/test/s747-invoice-review.test.ts apps/api/test/s747-till-code-review.test.ts apps/pos/src/pages/OrderStation.tsx apps/pos/src/lib/tillVoucher.ts apps/pos/test/s746-typed-band-review.test.ts > C:/oto-lanes/s747-lint.log 2>&1
pnpm --filter @oto/api api-types --check > C:/oto-lanes/s747-contracts.log 2>&1
pnpm exec turbo run test --filter='!@oto/api' > C:/oto-lanes/s747-workspace.log 2>&1
pnpm build > C:/oto-lanes/s747-build.log 2>&1
