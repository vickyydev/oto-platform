const APP_ENV = process.env.APP_ENV;
const STORAGE_ENV_PREFIX = process.env.STORAGE_ENV_PREFIX;
const OBJECT_STORAGE = process.env.OBJECT_STORAGE as "local" | "s3" | "replit";

if (!APP_ENV) {
  throw new Error("APP_ENV environment variable is required. Set APP_ENV=dev for development.");
}

if (!STORAGE_ENV_PREFIX) {
  throw new Error("STORAGE_ENV_PREFIX environment variable is required. Example: dev, staging, prod");
}

if (!OBJECT_STORAGE) {
  throw new Error(
    "OBJECT_STORAGE environment variable is required. " +
    "Allowed values: local, s3, replit"
  );
}

if (OBJECT_STORAGE !== "local" && OBJECT_STORAGE !== "s3" && OBJECT_STORAGE !== "replit") {
  throw new Error(
    `OBJECT_STORAGE must be one of: local, s3, replit. Got: "${OBJECT_STORAGE}"`
  );
}

function assertDevEnv(): void {
  if (APP_ENV !== "dev") {
    throw new Error(`This operation is only allowed in dev environment. Current APP_ENV=${APP_ENV}`);
  }
}

export { APP_ENV, STORAGE_ENV_PREFIX, OBJECT_STORAGE, assertDevEnv };
