CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitation_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_workspace_id_email_index" ON "invitation" USING btree ("workspace_id","email") WHERE accepted_at is null;--> statement-breakpoint
CREATE INDEX "invitation_email_index" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitation" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
-- What the app role may do with invitations: read and write a workspace's own, behind row-level
-- security. Memberships stay with the trusted server path: accepting one writes there, not the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation" TO coldlyne_app;
