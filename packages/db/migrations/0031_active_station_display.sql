-- Preserve existing credentials. A conflicting live pair needs an explicit
-- revocation in Console; a migration must not choose which screen to remove.
DO $$
DECLARE duplicate_station_count integer;
BEGIN
  SELECT count(*)::integer INTO duplicate_station_count
  FROM (
    SELECT station_id FROM core.device_credential
    WHERE kind = 'display' AND revoked_at IS NULL AND paired_at IS NOT NULL AND secret_hash IS NOT NULL
    GROUP BY station_id HAVING count(*) > 1
  ) AS duplicate_stations;
  IF duplicate_station_count > 0 THEN
    RAISE EXCEPTION 'Cannot enforce one active display per station: % station(s) have multiple live paired displays. Revoke obsolete displays in Console and retry the migration.', duplicate_station_count
      USING ERRCODE = '23505', CONSTRAINT = 'device_credential_active_display_unique';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "device_credential_active_display_unique" ON "core"."device_credential" USING btree ("station_id") WHERE kind = 'display' and revoked_at is null and paired_at is not null and secret_hash is not null;
