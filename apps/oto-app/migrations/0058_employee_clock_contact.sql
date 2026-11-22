-- Keep the employee contact and the tablet lookup in step for HR edits and imports.
-- Existing contacts were reviewed separately before the production repair.
CREATE OR REPLACE FUNCTION employee_clock_contact_number(raw_phone text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN digits ~ '^0[689][0-9]{8}$' THEN '+66' || substr(digits, 2)
    WHEN digits ~ '^[689][0-9]{8}$' THEN '+66' || digits
    WHEN digits ~ '^66[689][0-9]{8}$' THEN '+' || digits
    WHEN digits ~ '^\+?660[689][0-9]{8}$' THEN '+66' || right(digits, 9)
    WHEN digits ~ '^\+66[689][0-9]{8}$' THEN digits
    WHEN digits ~ '^\+[1-9][0-9]{9,14}$' AND digits NOT LIKE '+66%' THEN digits
    ELSE NULL
  END
  FROM (SELECT regexp_replace(raw_phone, '[[:space:]().-]', '', 'g') AS digits) input
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_employee_clock_contact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Older callers can supply a clock number alone.
    IF NEW.phone IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;
  NEW.phone_e164 := otoapp.employee_clock_contact_number(NEW.phone);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER employee_clock_contact_written
BEFORE INSERT OR UPDATE OF phone ON employees
FOR EACH ROW EXECUTE FUNCTION sync_employee_clock_contact();
