CREATE TABLE IF NOT EXISTS "pod_mutex_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"holding_statuses" text[] DEFAULT '{"todo","in_progress"}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_mutex_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pod_mutex_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pod_mutex_labels_company_label_idx" ON "pod_mutex_labels" USING btree ("company_id","label_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pod_mutex_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"holder_root_issue_id" uuid NOT NULL,
	"acquired_by_issue_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pod_mutex_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pod_mutex_leases_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pod_mutex_leases_holder_root_issue_id_issues_id_fk" FOREIGN KEY ("holder_root_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "pod_mutex_leases_acquired_by_issue_id_issues_id_fk" FOREIGN KEY ("acquired_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pod_mutex_leases_company_label_idx" ON "pod_mutex_leases" USING btree ("company_id","label_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pod_mutex_leases_holder_idx" ON "pod_mutex_leases" USING btree ("holder_root_issue_id");
