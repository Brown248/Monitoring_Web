CREATE TABLE "lookalike_domains" (
	"domain" varchar(253) PRIMARY KEY NOT NULL,
	"matched_keyword" varchar(100) NOT NULL,
	"similarity" varchar(20) NOT NULL,
	"cert_id" bigint,
	"issuer" text,
	"not_before" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(12) DEFAULT 'NEW' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "postmortems" (
	"incident_id" integer PRIMARY KEY NOT NULL,
	"status" "ai_analysis_status" DEFAULT 'PENDING' NOT NULL,
	"content" jsonb,
	"provider" varchar(50),
	"model" varchar(100),
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "security_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"website_id" integer,
	"type" varchar(40) NOT NULL,
	"severity" varchar(10) NOT NULL,
	"title" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" integer,
	"notified_at" timestamp with time zone,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"notify_error" text
);
--> statement-breakpoint
CREATE TABLE "security_scans" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "security_scans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" smallint,
	"grade" varchar(2),
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tls_valid_to" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "visual_snapshots" (
	"website_id" integer NOT NULL,
	"kind" varchar(10) NOT NULL,
	"image" "bytea",
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"diff_ratio" real,
	"keywords" jsonb,
	"page_title" text,
	"error" text,
	CONSTRAINT "visual_snapshots_pk" PRIMARY KEY("website_id","kind")
);
--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_snapshots" ADD CONSTRAINT "visual_snapshots_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lookalike_domains_seen_idx" ON "lookalike_domains" USING btree ("first_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "postmortems_pending_idx" ON "postmortems" USING btree ("requested_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "security_alerts_created_idx" ON "security_alerts" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_alerts_notify_idx" ON "security_alerts" USING btree ("created_at") WHERE notified_at IS NULL;--> statement-breakpoint
CREATE INDEX "security_scans_website_idx" ON "security_scans" USING btree ("website_id","scanned_at" DESC NULLS LAST);