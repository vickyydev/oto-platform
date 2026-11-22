-- Explicit alternate numbers approved for attendance. The employee contact stays primary.
CREATE TABLE IF NOT EXISTS employee_clock_alternate_phones (
  employee_id varchar PRIMARY KEY CONSTRAINT employee_clock_alternate_phones_employee_id_employees_id_fk REFERENCES employees(id) ON DELETE CASCADE,
  user_id varchar NOT NULL CONSTRAINT employee_clock_alternate_phones_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_employee_clock_alternate_phone ON employee_clock_alternate_phones(phone_e164);
