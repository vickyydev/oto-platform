-- Optional expiry for booth PINs. Existing credentials remain unexpired.
ALTER TABLE "core"."credential" ADD COLUMN "expires_at" timestamp with time zone;
