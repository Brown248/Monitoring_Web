CREATE TABLE "diagnoses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "diagnoses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"incident_id" integer,
	"trigger" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"verdict" jsonb NOT NULL,
	"steps" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journey_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"duration_ms" integer NOT NULL,
	"failed_step" integer,
	"error" text,
	"step_ms" jsonb,
	"screenshot" "bytea"
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"website_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"steps" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "site_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"field" varchar(40) NOT NULL,
	"label" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"severity" varchar(10) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_fingerprints" (
	"website_id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_dependencies" (
	"website_id" integer NOT NULL,
	"depends_on_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_dependencies_pk" PRIMARY KEY("website_id","depends_on_id"),
	CONSTRAINT "website_dependencies_not_self" CHECK (website_id <> depends_on_id)
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "root_cause_website_id" integer;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_runs" ADD CONSTRAINT "journey_runs_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_changes" ADD CONSTRAINT "site_changes_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_fingerprints" ADD CONSTRAINT "site_fingerprints_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_dependencies" ADD CONSTRAINT "website_dependencies_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_dependencies" ADD CONSTRAINT "website_dependencies_depends_on_id_websites_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "diagnoses_website_idx" ON "diagnoses" USING btree ("website_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "diagnoses_incident_idx" ON "diagnoses" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "journey_runs_website_idx" ON "journey_runs" USING btree ("website_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "site_changes_website_idx" ON "site_changes" USING btree ("website_id","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_root_cause_website_id_websites_id_fk" FOREIGN KEY ("root_cause_website_id") REFERENCES "public"."websites"("id") ON DELETE set null ON UPDATE no action;