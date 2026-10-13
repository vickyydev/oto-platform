-- Hand-written SQL carried over from the export's migration chain: the parts
-- Drizzle's table definitions cannot express. Unqualified on purpose — the
-- migrator applies it with search_path set to `radar`.
--
-- From the export's 0009: the booth event lifecycle states the Spin & Win
-- game sends.
ALTER TABLE booth_events ADD CONSTRAINT booth_events_event_type_check
  CHECK (event_type IN ('prize_won', 'claimed', 'redeemed', 're_redeemed', 'expired'));

-- From the export's 0010 (unchanged below this line).
-- OTO Lucky Wheel uses a ledger wholly separate from legacy campaign_qrs.
-- A code is never recycled: exhausted capacity intentionally halts issuance.
CREATE TABLE IF NOT EXISTS spin_reward_campaigns (
  campaign_id text PRIMARY KEY,
  prize_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  customer_value text NOT NULL,
  title text NOT NULL,
  instructions text NOT NULL,
  terms text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS spin_reward_code_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  win_id text NOT NULL UNIQUE,
  prize_id text NOT NULL REFERENCES spin_reward_campaigns(prize_id),
  campaign_id text NOT NULL REFERENCES spin_reward_campaigns(campaign_id),
  code char(4) NOT NULL UNIQUE CHECK (code ~ '^[0-9]{4}$'),
  won_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((redeemed_at IS NULL) OR (redeemed_at >= won_at))
);

CREATE INDEX IF NOT EXISTS idx_spin_reward_ledger_prize_redeemed
  ON spin_reward_code_ledger (prize_id, redeemed_at);
CREATE INDEX IF NOT EXISTS idx_spin_reward_ledger_code
  ON spin_reward_code_ledger (code);

-- Historical all-numeric legacy codes are copied once and remain reserved even
-- if their campaign/QR is later deleted. They must remain updateable for the
-- old campaign redemption flow, so this is intentionally not a CHECK
-- constraint on campaign_qrs.
CREATE TABLE IF NOT EXISTS spin_reward_legacy_code_reservations (
  code char(4) PRIMARY KEY CHECK (code ~ '^[0-9]{4}$'),
  reserved_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO spin_reward_legacy_code_reservations (code)
SELECT DISTINCT short_code::char(4)
FROM campaign_qrs
WHERE short_code ~ '^[0-9]{4}$'
ON CONFLICT (code) DO NOTHING;

-- Future legacy codes must contain a letter, but updates to an unchanged old
-- numeric code (for example its normal redemption status update) are allowed.
CREATE OR REPLACE FUNCTION spin_reward_prevent_numeric_campaign_qr()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.short_code ~ '^[0-9]{4}$'
     AND (TG_OP = 'INSERT' OR NEW.short_code IS DISTINCT FROM OLD.short_code) THEN
    RAISE EXCEPTION 'new campaign QR short codes cannot be four digits only';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS spin_reward_prevent_numeric_campaign_qr_trigger ON campaign_qrs;
CREATE TRIGGER spin_reward_prevent_numeric_campaign_qr_trigger
  BEFORE INSERT OR UPDATE OF short_code ON campaign_qrs
  FOR EACH ROW EXECUTE FUNCTION spin_reward_prevent_numeric_campaign_qr();

-- A historical reservation is permanent too: deleting or mutating it would
-- make it possible to accidentally recycle a lifetime legacy voucher code.
CREATE OR REPLACE FUNCTION spin_reward_prevent_legacy_reservation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spin reward legacy code reservations are immutable';
END;
$$;
DROP TRIGGER IF EXISTS spin_reward_legacy_reservation_prevent_update_trigger ON spin_reward_legacy_code_reservations;
CREATE TRIGGER spin_reward_legacy_reservation_prevent_update_trigger
  BEFORE UPDATE ON spin_reward_legacy_code_reservations
  FOR EACH ROW EXECUTE FUNCTION spin_reward_prevent_legacy_reservation_mutation();
DROP TRIGGER IF EXISTS spin_reward_legacy_reservation_prevent_delete_trigger ON spin_reward_legacy_code_reservations;
CREATE TRIGGER spin_reward_legacy_reservation_prevent_delete_trigger
  BEFORE DELETE ON spin_reward_legacy_code_reservations
  FOR EACH ROW EXECUTE FUNCTION spin_reward_prevent_legacy_reservation_mutation();
DROP TRIGGER IF EXISTS spin_reward_legacy_reservation_prevent_truncate_trigger ON spin_reward_legacy_code_reservations;
CREATE TRIGGER spin_reward_legacy_reservation_prevent_truncate_trigger
  BEFORE TRUNCATE ON spin_reward_legacy_code_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION spin_reward_prevent_legacy_reservation_mutation();

CREATE TABLE IF NOT EXISTS spin_reward_rate_limits (
  bucket_key char(64) PRIMARY KEY CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

-- Insert only missing rewards so a future explicit activation/deactivation is
-- not overwritten when this idempotent migration is encountered again.
INSERT INTO spin_reward_campaigns
  (campaign_id, prize_id, display_name, customer_value, title, instructions, terms, active)
VALUES
  ('spin-wheel-voucher-100', 'voucher-100', '100 THB Voucher', '100 THB', 'YOU WON 100 THB!', 'Show this QR at OTO Reception and get 100 THB off your ticket order.', 'Cannot be combined with other offers.', true),
  ('spin-wheel-bracelet-making', 'bracelet-making', 'Free Bracelet Workshop', 'Free Bracelet Workshop', 'YOU WON A FREE BRACELET WORKSHOP!', 'Show this QR at OTO and create your own bracelet with us.', NULL, true),
  ('spin-wheel-voucher-150', 'voucher-150', '150 THB Voucher', '150 THB', 'YOU WON 150 THB!', 'Show this QR at OTO Reception and get 150 THB off your ticket order.', 'Cannot be combined with other offers.', true),
  ('spin-wheel-voucher-200', 'voucher-200', '200 THB Voucher', '200 THB', 'YOU WON 200 THB!', 'Show this QR at OTO Reception and get 200 THB off your ticket order.', 'Cannot be combined with other offers.', true),
  ('spin-wheel-kids-pizza', 'kids-pizza', 'Kids Pizza', '1 mini pizza + 1 juice', 'YOU WON A FREE KIDS PIZZA!', E'Enjoy 1 mini pizza + 1 juice of your choice at OTO Restaurant.\n\nShow this QR to redeem your prize.', NULL, true),
  ('spin-wheel-kids-ticket-1-plus-1', 'kids-ticket-1-plus-1', '1+1 Kids Ticket', '1+1 Kids Ticket', 'YOU WON 1+1 KIDS TICKETS!', 'Bring 2 children and pay for only 1 kids ticket.', 'Not valid for Eat & Play. Cannot be combined with other offers.', true),
  ('spin-wheel-mystery-gift', 'mystery-gift', 'Mystery Gift', 'Mystery Gift', 'YOU WON A MYSTERY GIFT!', 'Show this QR at OTO Reception to receive your surprise.', NULL, false)
ON CONFLICT (campaign_id) DO NOTHING;

-- The identity of an issued voucher and a redeemed timestamp cannot be
-- changed or cleared. Redemption is the only permitted ledger update.
CREATE OR REPLACE FUNCTION spin_reward_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.win_id IS DISTINCT FROM OLD.win_id
     OR NEW.prize_id IS DISTINCT FROM OLD.prize_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.won_at IS DISTINCT FROM OLD.won_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.redeemed_at IS NOT NULL AND NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at)
     OR (OLD.redeemed_at IS NULL AND NEW.redeemed_at IS NULL) THEN
    RAISE EXCEPTION 'spin reward ledger entries are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spin_reward_ledger_immutable_trigger ON spin_reward_code_ledger;
CREATE TRIGGER spin_reward_ledger_immutable_trigger
  BEFORE UPDATE ON spin_reward_code_ledger
  FOR EACH ROW EXECUTE FUNCTION spin_reward_ledger_immutable();

-- The ledger is append-only: redemption may set redeemed_at once, but issued
-- entries cannot be deleted or truncated to make a code reusable.
CREATE OR REPLACE FUNCTION spin_reward_ledger_prevent_removal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spin reward ledger entries cannot be removed';
END;
$$;
DROP TRIGGER IF EXISTS spin_reward_ledger_prevent_delete_trigger ON spin_reward_code_ledger;
CREATE TRIGGER spin_reward_ledger_prevent_delete_trigger
  BEFORE DELETE ON spin_reward_code_ledger
  FOR EACH ROW EXECUTE FUNCTION spin_reward_ledger_prevent_removal();
DROP TRIGGER IF EXISTS spin_reward_ledger_prevent_truncate_trigger ON spin_reward_code_ledger;
CREATE TRIGGER spin_reward_ledger_prevent_truncate_trigger
  BEFORE TRUNCATE ON spin_reward_code_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION spin_reward_ledger_prevent_removal();