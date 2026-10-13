FROM node:22-bookworm-slim AS base
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
# Everything, including devDependencies: the build needs vite, esbuild and tsx.
RUN npm ci --ignore-scripts

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
ARG APP_VERSION
ARG APP_CHANGE_ID
COPY . .
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# The migrator and the SQL it applies. The pre-deploy step runs
# `npm run db:migrate` in this image before the new instance takes traffic;
# the server itself never migrates and refuses to start without the schema.
# script/migrate.mjs is plain JavaScript needing only pg and drizzle-orm,
# because there is no tsx or drizzle-kit in a --omit=dev install.
COPY migrations/ ./migrations/
COPY script/migrate.mjs ./script/migrate.mjs

ARG APP_VERSION
ARG APP_CHANGE_ID

ENV NODE_ENV=production
ENV PORT=8080
ENV APP_VERSION=$APP_VERSION
ENV APP_CHANGE_ID=$APP_CHANGE_ID
# Store UTC, convert at the edge with the branch's timezone.
ENV TZ=UTC
# Response bodies can carry customer data; keep them out of the logs.
ENV LOG_RESPONSE_BODY=false

EXPOSE 8080

# Drop root: nothing in Radar writes to the filesystem at runtime.
USER node

CMD ["node", "dist/index.cjs"]
