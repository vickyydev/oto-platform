FROM node:22-bookworm-slim AS base
WORKDIR /app

# Install Chromium and its dependencies for Puppeteer PDF generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-thai-tlwg \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
# Install all deps (including devDependencies needed for the build step)
RUN npm ci --ignore-scripts

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
# VITE_ vars must be available at build time to be embedded in the client
# bundle. Declaring ARG before COPY ensures a changed value busts the build
# cache.
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
# Where the client's "open the HR app" links point. Its fallback in the client
# source is a Replit workspace URL, so leaving this unset sends people from
# this deployment to a host that is not ours.
ARG VITE_HR_APP_URL
ENV VITE_HR_APP_URL=$VITE_HR_APP_URL
ARG APP_VERSION
ARG APP_CHANGE_ID
COPY . .
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app

# Only copy production deps
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output
COPY --from=builder /app/dist ./dist

# The migrator and the SQL it applies. They are in the runtime image because
# the pre-deploy step runs there (render.yaml), against this service's own
# database role, before the new instance takes any traffic. script/migrate.mjs
# is plain JavaScript needing only pg and drizzle-orm for exactly this reason:
# the runtime install is --omit=dev, so there is no tsx and no drizzle-kit here.
COPY migrations/ ./migrations/
COPY script/migrate.mjs ./script/migrate.mjs
# Issues and revokes the directory API's tenant-bound keys; plain JavaScript
# needing only pg, for the same reason as the migrator.
COPY script/directory-client.mjs ./script/directory-client.mjs
# The tenant ownership read-back (`npm run tenant:readback`, read only), so a
# deployment can be read back from its own shell, as its own database role,
# before and after migration 0007 (S2-17b round 4b).
COPY script/tenant-ownership-readback.mjs ./script/tenant-ownership-readback.mjs

ARG APP_VERSION
ARG APP_CHANGE_ID

ENV NODE_ENV=production
ENV PORT=8080
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV APP_VERSION=$APP_VERSION
ENV APP_CHANGE_ID=$APP_CHANGE_ID
# Every process on this platform stores UTC and converts at the edge using the
# branch's timezone. A container on Asia/Bangkok would make a day boundary
# depend on where the code happens to run.
ENV TZ=UTC

EXPOSE 8080

# The process still runs as root, which it should not. It is left that way
# deliberately for now rather than changed blind: Chromium's sandbox and
# Puppeteer's temporary files both care who the user is, /app is owned by root
# because npm ci ran as root, and none of that can be verified without building
# and running the image. It belongs with the module walk-through in S2-17b,
# where every PDF path is exercised anyway.

CMD ["node", "dist/index.cjs"]
