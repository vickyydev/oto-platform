import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

console.log("[sentry] SENTRY_DSN:", dsn ? `${dsn.slice(0, 20)}...` : "NOT SET");

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? "unknown",
    release: process.env.APP_CHANGE_ID ?? process.env.APP_VERSION,
    debug: true,
  });
  console.log("[sentry] Initialized with environment:", process.env.APP_ENV ?? "unknown");
} else {
  console.log("[sentry] Skipping init — no DSN set");
}

export { Sentry };
