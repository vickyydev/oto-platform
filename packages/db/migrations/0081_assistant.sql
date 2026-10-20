-- SCRUM-591 (Inbox AI, Phase 3, round I1, lane b) — the internal assistant's ask-log.
--
-- Plan: docs/progress/plans/internal-assistant-build/PLAN.md §D.3 (the
-- ask-log), §E.1 (text lives only here), R5. Expand-only: a new schema
-- `assistant` (now in OWNED_SCHEMAS and drizzle's schemaFilter) and two new
-- tables. No row is written here, and nothing existing is altered; the two
-- new permissions are laid by platform-sync (system bundles) and its inbox
-- late-grant step (the inbox roles).
--
--   assistant.ask        one question a person asked on the launcher: the
--                        asker (account, session — soft, seat branch), the
--                        question (<= 2,000), the answer as shown (<= 4,000),
--                        resolved links (<= 3), the routes' refusal lines
--                        verbatim, a state, a one-word reason, model and
--                        persona words, token counts, latency, the asker's
--                        verdict and correction (<= 1,000, only on `wrong`),
--                        and `purge_after` (default asked + 90 days, owner G4).
--                        Written first in `asking`, so a retry finds it.
--   assistant.tool_call  one tool call made for an ask, as the asker: the
--                        tool, its system, the route TEMPLATE (GET only, no
--                        query string, by CHECK), the validated arguments,
--                        status, error code, rows, bytes, truncated, latency.
--                        No response body. Deleted with its ask (CASCADE).
--
-- No free text outside question, answer, correction and the refusal lines:
-- every other text column is an enum or one word by CHECK. The tenant fence
-- holds: tool_call reaches its ask by (operator_id, ask_id).
--
-- TO REVERSE (drops every ask and tool call recorded since):
--   DROP SCHEMA "assistant" CASCADE;
CREATE SCHEMA IF NOT EXISTS "assistant";
--> statement-breakpoint
CREATE TABLE "assistant"."ask" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"session_id" uuid,
	"branch_id" uuid,
	"question" text NOT NULL,
	"answer" text,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refusals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'asking' NOT NULL,
	"reason" text,
	"model" text,
	"persona_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"latency_ms" integer,
	"feedback" text,
	"correction" text,
	"purge_after" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "ask_state_check" CHECK ("assistant"."ask"."state" in ('asking','answered','refused','link_only','failed','capped','off')),
	CONSTRAINT "ask_reason_check" CHECK ("assistant"."ask"."reason" is null or "assistant"."ask"."reason" ~ '^[A-Z][A-Z0-9_]{0,47}$'),
	CONSTRAINT "ask_version_words_check" CHECK (("assistant"."ask"."model" is null or "assistant"."ask"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')
          and ("assistant"."ask"."persona_version" is null or "assistant"."ask"."persona_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')),
	CONSTRAINT "ask_length_check" CHECK (char_length("assistant"."ask"."question") between 1 and 2000
          and ("assistant"."ask"."answer" is null or char_length("assistant"."ask"."answer") <= 4000)
          and ("assistant"."ask"."correction" is null or char_length("assistant"."ask"."correction") between 1 and 1000)),
	CONSTRAINT "ask_shapes_check" CHECK (jsonb_typeof("assistant"."ask"."links") = 'array' and jsonb_array_length("assistant"."ask"."links") <= 3
          and jsonb_typeof("assistant"."ask"."refusals") = 'array'),
	CONSTRAINT "ask_feedback_check" CHECK ("assistant"."ask"."feedback" is null or "assistant"."ask"."feedback" in ('good','wrong')),
	CONSTRAINT "ask_correction_check" CHECK ("assistant"."ask"."correction" is null or coalesce("assistant"."ask"."feedback" = 'wrong', false)),
	CONSTRAINT "ask_asking_check" CHECK ("assistant"."ask"."state" <> 'asking' or ("assistant"."ask"."answer" is null and "assistant"."ask"."feedback" is null)),
	CONSTRAINT "ask_counts_check" CHECK (("assistant"."ask"."input_tokens" is null or "assistant"."ask"."input_tokens" >= 0)
          and ("assistant"."ask"."output_tokens" is null or "assistant"."ask"."output_tokens" >= 0)
          and ("assistant"."ask"."cache_read_tokens" is null or "assistant"."ask"."cache_read_tokens" >= 0)
          and ("assistant"."ask"."latency_ms" is null or "assistant"."ask"."latency_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "assistant"."tool_call" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"ask_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"system" text NOT NULL,
	"route" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" integer,
	"code" text,
	"rows" integer,
	"bytes" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_call_seq_unique" UNIQUE("ask_id","seq"),
	CONSTRAINT "tool_call_tool_check" CHECK ("assistant"."tool_call"."tool" ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$'),
	CONSTRAINT "tool_call_system_check" CHECK ("assistant"."tool_call"."system" in ('platform','oto_app')),
	CONSTRAINT "tool_call_route_check" CHECK ("assistant"."tool_call"."route" ~ '^GET /[A-Za-z0-9_:./-]{0,199}$'),
	CONSTRAINT "tool_call_code_check" CHECK ("assistant"."tool_call"."code" is null or "assistant"."tool_call"."code" ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'),
	CONSTRAINT "tool_call_args_check" CHECK (jsonb_typeof("assistant"."tool_call"."args") = 'object'),
	CONSTRAINT "tool_call_counts_check" CHECK ("assistant"."tool_call"."seq" >= 1
          and ("assistant"."tool_call"."status" is null or "assistant"."tool_call"."status" between 100 and 599)
          and ("assistant"."tool_call"."rows" is null or "assistant"."tool_call"."rows" >= 0)
          and ("assistant"."tool_call"."bytes" is null or "assistant"."tool_call"."bytes" >= 0)
          and ("assistant"."tool_call"."latency_ms" is null or "assistant"."tool_call"."latency_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "assistant"."ask" ADD CONSTRAINT "ask_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."ask" ADD CONSTRAINT "ask_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."ask" ADD CONSTRAINT "ask_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."tool_call" ADD CONSTRAINT "tool_call_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant"."tool_call" ADD CONSTRAINT "tool_call_ask_fk" FOREIGN KEY ("operator_id","ask_id") REFERENCES "assistant"."ask"("operator_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_account_created_idx" ON "assistant"."ask" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ask_operator_created_idx" ON "assistant"."ask" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "ask_branch_idx" ON "assistant"."ask" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "ask_purge_after_idx" ON "assistant"."ask" USING btree ("purge_after");--> statement-breakpoint
CREATE INDEX "ask_feedback_idx" ON "assistant"."ask" USING btree ("operator_id","feedback","created_at") WHERE feedback is not null;--> statement-breakpoint
CREATE INDEX "tool_call_ask_fk_idx" ON "assistant"."tool_call" USING btree ("operator_id","ask_id");