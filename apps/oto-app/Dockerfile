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
# VITE_ vars must be available at build time to be embedded in the client bundle.
# Declaring ARG before COPY ensures a changed value busts the build cache.
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG APP_VERSION
ARG APP_CHANGE_ID
COPY . .
# Skip Replit-only vite plugins — they are guarded by REPL_ID checks in vite.config.ts
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

ARG APP_VERSION
ARG APP_CHANGE_ID

ENV NODE_ENV=production
ENV PORT=8080
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV APP_VERSION=$APP_VERSION
ENV APP_CHANGE_ID=$APP_CHANGE_ID

EXPOSE 8080

CMD ["node", "dist/index.cjs"]
