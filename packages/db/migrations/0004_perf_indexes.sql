CREATE INDEX "diagnoses_created_idx" ON "diagnoses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "incidents_first_failure_check_idx" ON "incidents" USING btree ("first_failure_check_id") WHERE first_failure_check_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_confirm_check_idx" ON "incidents" USING btree ("confirm_check_id") WHERE confirm_check_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_recovery_check_idx" ON "incidents" USING btree ("recovery_check_id") WHERE recovery_check_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journey_runs_started_idx" ON "journey_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "security_scans_scanned_idx" ON "security_scans" USING btree ("scanned_at");--> statement-breakpoint
CREATE INDEX "site_changes_at_idx" ON "site_changes" USING btree ("at");