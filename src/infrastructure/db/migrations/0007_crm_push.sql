CREATE TABLE "crm_push" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"connection_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"note_hash" text NOT NULL,
	"pushed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "crm_push_connectionId_prospectId_noteHash_unique" UNIQUE("connection_id","prospect_id","note_hash")
);
--> statement-breakpoint
ALTER TABLE "crm_push" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_push" ADD CONSTRAINT "crm_push_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_push" ADD CONSTRAINT "crm_push_prospect_id_prospect_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospect"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "crm_push" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "crm_push" TO coldlyne_app;
