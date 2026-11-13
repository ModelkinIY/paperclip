CREATE TABLE IF NOT EXISTS "company_adapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_connection" jsonb,
	"default_environment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_adapters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_adapters_company_name_uq" ON "company_adapters" USING btree ("company_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_adapters_company_idx" ON "company_adapters" USING btree ("company_id");
--> statement-breakpoint
ALTER TABLE "agent_inference_slots" ADD COLUMN IF NOT EXISTS "adapter_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_inference_slots" ALTER COLUMN "adapter_type" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_inference_slots" ADD CONSTRAINT "agent_inference_slots_adapter_id_company_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."company_adapters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_inference_slots_agent_adapter_uq" ON "agent_inference_slots" USING btree ("agent_id","adapter_id") WHERE "adapter_id" IS NOT NULL;
