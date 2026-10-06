#!/usr/bin/env bash
# Setup for a hosted (cloud) Claude Code session on this repository.
# Paste into the cloud environment's "Setup script", or run by hand once:
#   bash scripts/agent/cloud-setup.sh
# Needs network access to npm, GitHub, Docker Hub and the Playwright CDN.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "== pnpm"
corepack enable >/dev/null 2>&1 && corepack prepare pnpm@10.33.0 --activate >/dev/null 2>&1 || npm install -g pnpm@10.33.0
pnpm install --frozen-lockfile

echo "== Postgres on localhost:5433 (user oto / password oto / db oto)"
if docker info >/dev/null 2>&1 || (sudo service docker start >/dev/null 2>&1 && sleep 3 && docker info >/dev/null 2>&1); then
  docker compose -f infra/docker-compose.yml up -d postgres
else
  echo "Docker unavailable; using the preinstalled PostgreSQL on port 5433"
  sudo service postgresql start
  sudo -u postgres psql -c "ALTER SYSTEM SET port = 5433" && sudo service postgresql restart
  sudo -u postgres psql -p 5433 -tc "SELECT 1 FROM pg_roles WHERE rolname='oto'" | grep -q 1 \
    || sudo -u postgres psql -p 5433 -c "CREATE ROLE oto LOGIN SUPERUSER PASSWORD 'oto'"
  sudo -u postgres psql -p 5433 -tc "SELECT 1 FROM pg_database WHERE datname='oto'" | grep -q 1 \
    || sudo -u postgres createdb -p 5433 -O oto oto
fi
for i in $(seq 1 30); do pg_isready -h localhost -p 5433 >/dev/null 2>&1 && break; sleep 2; done
pg_isready -h localhost -p 5433 || echo "WARNING: Postgres is not answering on 5433"

echo "== Approved till design (reference only, never committed)"
if [ ! -d imports/oto-pos/artifacts ] && [ -n "${PROTOTYPE_REPO:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${PROTOTYPE_REPO}.git" imports/oto-pos
fi
[ -d imports/oto-pos/artifacts/oto-till/src ] && echo "design reference present" || echo "WARNING: imports/oto-pos missing (set PROTOTYPE_REPO and GH_TOKEN)"

echo "== Browser for staging evidence"
pnpm --filter @oto/pos exec playwright install --with-deps chromium >/dev/null 2>&1 || pnpm --filter @oto/pos exec playwright install chromium || true

echo "== Repo-root .env for the agent helpers (from the session environment)"
if [ ! -f .env ]; then
  env | grep -E '^(JIRA_|RENDER_API_KEY|STAGING_|TEST_DATABASE_URL|DATABASE_URL)' > .env || true
fi
grep -q '^DATABASE_URL=' .env 2>/dev/null || echo 'DATABASE_URL=postgres://oto:oto@localhost:5433/oto' >> .env
grep -q '^TEST_DATABASE_URL=' .env 2>/dev/null || echo 'TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/oto' >> .env
echo "setup done"
