set -eo pipefail
pnpm --filter @oto/api exec tsx C:/oto-lanes/s747-api-gate.mts > C:/oto-lanes/s747-api-full.log 2>&1
