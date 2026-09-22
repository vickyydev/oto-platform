-- SCRUM-275 — somewhere for a box to keep its cache.
--
-- `SqlBoxStore` in `@oto/box-agent` has read and written `box_cache` since
-- S2-05, and on a Raspberry Pi it is a real SQLite table that survives a power
-- cut. On Postgres there was no such table, so the virtual box that runs inside
-- the api held its bundles in a `Map` on the store object and lost them with the
-- process: every deploy threw away the staff list and the deny-list an offline
-- unlock is decided from, until the next pull happened to refill them. The
-- store said so in a comment where the map was declared; this is that comment's
-- answer.
--
-- **The shape is transcribed, not designed.** The columns are the SQLite table
-- in `packages/box-agent/src/store-sqlite.ts`, in Postgres types: the same
-- primary key (box_id, scope), the same `payload` holding a whole scope rather
-- than a page of one, and the same `applied_at`. No `created_at` or
-- `updated_at`, matching the Pi's table and the five tables 0013 added beside
-- it: this is a last-writer row whose whole content is its current value, and
-- `applied_at` already says when that value arrived.
--
-- **One column the Pi does not have: `operator_id`.** A Pi's file is a
-- single-tenant file and has nothing to point at; the platform database is not,
-- and the nine `edge` tables already there carry only `box_id`
-- (`UNTENANTED_DEBT` in `packages/db/test/schema-shape.test.ts`, owed on each of
-- them). A table created today is created conforming rather than joining that
-- list, and it costs nothing to fill: the store's upsert takes the operator from
-- `core.box` in the same statement, so no caller had to learn a new argument.
--
-- **Create only.** One new table in `edge`, two foreign keys and one index, all
-- over a table this migration has just created — nothing here can refuse to
-- build on a live database, and nothing existing is renamed, retyped or dropped.
-- Boxes start empty and refill on their next cache tick, which is a minute.

CREATE TABLE "edge"."box_cache" (
	"box_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "box_cache_box_id_scope_pk" PRIMARY KEY("box_id","scope")
);
--> statement-breakpoint
ALTER TABLE "edge"."box_cache" ADD CONSTRAINT "box_cache_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_cache" ADD CONSTRAINT "box_cache_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_cache_operator_idx" ON "edge"."box_cache" USING btree ("operator_id");