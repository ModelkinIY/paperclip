CREATE TABLE IF NOT EXISTS "ai_grant_limit_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"pace_model" text DEFAULT 'linear' NOT NULL,
	"weekly_params" jsonb,
	"five_hour_params" jsonb,
	"max_stale_minutes" integer,
	"last_observation" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "ai_grant_limit_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ai_grant_limit_settings_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_grant_limit_settings_company_grant_uq" ON "ai_grant_limit_settings" USING btree ("company_id","grant_id");
