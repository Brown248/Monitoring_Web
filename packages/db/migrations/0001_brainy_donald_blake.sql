CREATE TABLE "website_icons" (
	"website_id" integer PRIMARY KEY NOT NULL,
	"site_url" text NOT NULL,
	"ok" boolean NOT NULL,
	"content" "bytea",
	"content_type" varchar(50),
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "website_icons" ADD CONSTRAINT "website_icons_website_id_websites_id_fk" FOREIGN KEY ("website_id") REFERENCES "public"."websites"("id") ON DELETE cascade ON UPDATE no action;