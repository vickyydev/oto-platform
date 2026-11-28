CREATE TABLE "payroll_booth_bonuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"station_id" uuid NOT NULL,
	"branch_id" varchar NOT NULL,
	"redemption_month" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	"rate_satang" integer NOT NULL,
	"redemption_window" text NOT NULL,
	CONSTRAINT "payroll_booth_bonus_valid" CHECK ("payroll_booth_bonuses"."rate_satang" >= 0 and "payroll_booth_bonuses"."used_at" >= "payroll_booth_bonuses"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "payroll_booth_person_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" varchar NOT NULL,
	"effective_from" date NOT NULL,
	"effective_until" date,
	"rate_satang" integer,
	"reading_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_booth_rate_valid" CHECK (("payroll_booth_person_rates"."rate_satang" is null or "payroll_booth_person_rates"."rate_satang" >= 0) and ("payroll_booth_person_rates"."effective_until" is null or "payroll_booth_person_rates"."effective_until" >= "payroll_booth_person_rates"."effective_from"))
);
--> statement-breakpoint
CREATE TABLE "payroll_booth_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"rate_satang" integer NOT NULL,
	"redemption_window" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_booth_rule_valid" CHECK ("payroll_booth_rules"."rate_satang" >= 0 and "payroll_booth_rules"."redemption_window" in ('same-day','24-hours','7-days','30-days','any-time'))
);
--> statement-breakpoint
ALTER TABLE "payroll_booth_bonuses" ADD CONSTRAINT "payroll_booth_bonuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_booth_bonuses" ADD CONSTRAINT "payroll_booth_bonus_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_booth_person_rates" ADD CONSTRAINT "payroll_booth_person_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_booth_person_rates" ADD CONSTRAINT "payroll_booth_rate_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_booth_rules" ADD CONSTRAINT "payroll_booth_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_booth_bonus_once" ON "payroll_booth_bonuses" USING btree ("tenant_id","voucher_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_booth_bonus_month" ON "payroll_booth_bonuses" USING btree ("tenant_id","redemption_month");--> statement-breakpoint
CREATE INDEX "payroll_booth_rate_lookup" ON "payroll_booth_person_rates" USING btree ("tenant_id","employee_id","effective_from","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_booth_rules_start" ON "payroll_booth_rules" USING btree ("tenant_id","effective_from");
--> statement-breakpoint
CREATE VIEW otoapp_v.booth_bonus_rules AS
SELECT b.core_branch_id, r.effective_from, r.rate_satang, r.redemption_window
  FROM payroll_booth_rules r
  JOIN branches b ON b.tenant_id = r.tenant_id
 WHERE b.core_branch_id IS NOT NULL;
--> statement-breakpoint
DO $grant$
DECLARE reader record;
BEGIN
  FOR reader IN
    SELECT DISTINCT pg_get_userbyid(grantee) AS role_name
      FROM pg_class c, LATERAL aclexplode(c.relacl) p
     WHERE c.oid = 'otoapp_v.employees'::regclass AND p.privilege_type = 'SELECT'
       AND p.grantee <> 0 AND p.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT SELECT ON otoapp_v.booth_bonus_rules TO %I', reader.role_name);
  END LOOP;
END $grant$;
