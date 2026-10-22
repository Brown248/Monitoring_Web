CREATE TYPE "public"."ai_analysis_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('UP', 'DOWN', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('INFO', 'SUCCESS', 'WARN', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."notification_event_type" AS ENUM('DOWN', 'RECOVERY');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('SUCCESS', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'VIEWER');--> statement-breakpoint
CREATE TABLE "ai_analyses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_analyses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"incident_id" integer NOT NULL,
	"status" "ai_analysis_status" DEFAULT 'PENDING' NOT NULL,
	"provider" varchar(50),
	"model" varchar(100),
	"summary" text,
	"facts" jsonb,
	"possible_causes" jsonb,
	"next_steps" jsonb,
	"input_check_count" integer,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_analyses_incident_unique" UNIQUE("incident_id")
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100),
	"success" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backup_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean NOT NULL,
	"size_bytes" bigint,
	"destination" text,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "canary_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "canary_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"target" text NOT NULL,
	"ok" boolean NOT NULL,
	"response_time_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "check_results" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "check_status" NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"http_status" smallint,
	"first_http_status" smallint,
	"response_time_ms" integer,
	"retries" smallint DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"error_message" text,
	"final_url" text,
	"redirect_count" smallint DEFAULT 0 NOT NULL,
	"remote_ip" varchar(64),
	"dns_ms" integer,
	"connect_ms" integer,
	"tls_ms" integer,
	"worker_id" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"website_id" integer NOT NULL,
	"day" date NOT NULL,
	"total_checks" integer DEFAULT 0 NOT NULL,
	"up_checks" integer DEFAULT 0 NOT NULL,
	"down_checks" integer DEFAULT 0 NOT NULL,
	"unknown_checks" integer DEFAULT 0 NOT NULL,
	"avg_response_ms" real,
	"p95_response_ms" real,
	"downtime_seconds" integer DEFAULT 0 NOT NULL,
	"incident_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_summaries_pk" PRIMARY KEY("website_id","day")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" "event_level" DEFAULT 'INFO' NOT NULL,
	"type" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"detail" text,
	"website_id" integer,
	"incident_id" integer
);
--> statement-breakpoint
CREATE TABLE "heartbeat_slots" (
	"slot" timestamp with time zone PRIMARY KEY NOT NULL,
	"beats" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "incidents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"website_id" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"recovered_at" timestamp with time zone,
	"cause" text NOT NULL,
	"error_code" varchar(64),
	"failed_check_count" integer DEFAULT 0 NOT NULL,
	"first_failure_check_id" bigint,
	"confirm_check_id" bigint,
	"recovery_check_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_recovered_after_start" CHECK (recovered_at IS NULL OR recovered_at >= started_at)
);
--> statement-breakpoint
CREATE TABLE "integration_sync_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "integration_sync_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"integration" varchar(50) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"status" "sync_status" NOT NULL,
	"cursor" text,
	"rows_synced" integer DEFAULT 0 NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" varchar(64) NOT NULL,
	"payload" jsonb,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"result" text,
	"requested_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"incident_id" integer NOT NULL,
	"event_type" "notification_event_type" NOT NULL,
	"recipient" varchar(320) NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"smtp_response" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_dedupe" UNIQUE("incident_id","event_type","recipient")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'VIEWER' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "website_state" (
	"website_id" integer PRIMARY KEY NOT NULL,
	"status" "check_status" DEFAULT 'UNKNOWN' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"failure_streak_started_at" timestamp with time zone,
	"failure_streak_first_check_id" bigint,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_status_change_at" timestamp with time zone,
	"last_result_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "websites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(200) NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"check_interval_seconds" integer DEFAULT 300 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"retry_count" smallint DEFAULT 2 NOT NULL,
	"retry_delay_ms" integer DEFAULT 3000 NOT NULL,
	"confirm_down_count" smallint DEFAULT 2 NOT NULL,
	"confirm_recovery_count" smallint DEFAULT 2 NOT NULL,
	"up_status_codes" varchar(200) DEFAULT '200-399' NOT NULL,
	"degraded_threshold_ms" integer,
	"treat_auth_as_up" boolean DEFAULT false NOT NULL,
	"follow_redirects" boolean DEFAULT true NOT NULL,
	"max_redirects" smallint DEFAULT 3 NOT NULL,
	"alert_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"send_recovery" boolean DEFAULT true NOT NULL,
	"ai_auto_analyze" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "websites_check_interval_min" CHECK (check_interval_seconds >= 60),
	CONSTRAINT "websites_timeout_range" CHECK (timeout_ms BETWEEN 1000 AND 60000),
	CONSTRAINT "websites_retry_range" CHECK (retry_count BETWEEN 0 AND 5),
	CONSTRAINT "websites_confirm_range" CHECK (confirm_down_count >= 1 AND confirm_recovery_count >= 1)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" varchar(100) PRIMARY KEY NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"pid" integer NOT NULL,
	"version" varchar(50),
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_cycle_at" timestamp with time zone,
	"last_cycle_checks" integer,
	"last_cycle_ms" integer
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_first_failure_check_id_check_results_id_fk" FOREIGN KEY ("first_failure_check_id") REFERENCES "public"."check_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_confirm_check_id_check_results_id_fk" FOREIGN KEY ("confirm_check_id") REFERENCES "public"."check_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_recovery_check_id_check_results_id_fk" FOREIGN KEY ("recovery_check_id") REFERENCES "public"."check_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requests" ADD CONSTRAINT "job_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_state" ADD CONSTRAINT "website_state_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_analyses_pending_idx" ON "ai_analyses" USING btree ("requested_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "ai_calls_at_idx" ON "ai_calls" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "canary_results_at_idx" ON "canary_results" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_results_website_checked_idx" ON "check_results" USING btree ("website_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_results_checked_at_idx" ON "check_results" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_incident_idx" ON "events" USING btree ("incident_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_website" ON "incidents" USING btree ("website_id") WHERE recovered_at IS NULL;--> statement-breakpoint
CREATE INDEX "incidents_website_started_idx" ON "incidents" USING btree ("website_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_started_idx" ON "incidents" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "integration_sync_logs_lookup_idx" ON "integration_sync_logs" USING btree ("integration","entity_type","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_requests_pending_idx" ON "job_requests" USING btree ("created_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "notification_events_due_idx" ON "notification_events" USING btree ("next_attempt_at") WHERE status IN ('PENDING', 'FAILED');--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "website_state_next_check_at_idx" ON "website_state" USING btree ("next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "websites_url_active_unique" ON "websites" USING btree ("url") WHERE archived_at IS NULL;