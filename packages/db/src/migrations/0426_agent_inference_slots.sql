CREATE TABLE IF NOT EXISTS "agent_inference_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text,
	"adapter_type" text NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_connection" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inference_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_inference_slots_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_inference_slots_agent_priority_idx" ON "agent_inference_slots" USING btree ("agent_id","priority");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_inference_slot_task_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"slot_id" text NOT NULL,
	"last_run_id" uuid,
	"last_run_finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inference_slot_task_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_inference_slot_task_state_company_agent_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_inference_slot_task_state_agent_task_uq" ON "agent_inference_slot_task_state" USING btree ("agent_id","task_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inference_exhaustions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid,
	"message" text,
	CONSTRAINT "inference_exhaustions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inference_exhaustions_company_key_uq" ON "inference_exhaustions" USING btree ("company_id","key");
--> statement-breakpoint
ALTER TABLE "ai_grant_limit_settings" ADD COLUMN IF NOT EXISTS "cache_keepalive_mode" text DEFAULT 'off' NOT NULL;
