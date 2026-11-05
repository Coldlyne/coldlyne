CREATE TYPE "public"."prospect_interest" AS ENUM('interested', 'not_now', 'not_interested', 'wrong_person');--> statement-breakpoint
CREATE TYPE "public"."approval_mode" AS ENUM('autonomous', 'approve_first');--> statement-breakpoint
CREATE TYPE "public"."enrollment_status" AS ENUM('active', 'waiting_member', 'stopped', 'finished');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('draft', 'awaiting_approval', 'approved', 'sending', 'sent', 'failed', 'skipped', 'to_do', 'done');--> statement-breakpoint
CREATE TYPE "public"."sequence_status" AS ENUM('draft', 'pending_approval', 'running', 'paused', 'finished');--> statement-breakpoint
CREATE TABLE "enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "enrollment_status" DEFAULT 'active' NOT NULL,
	"stop_reason" text,
	"last_position" integer DEFAULT -1 NOT NULL,
	"last_outcome" text,
	"next_due_at" timestamp with time zone,
	"mailbox_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_sequenceId_prospectId_unique" UNIQUE("sequence_id","prospect_id")
);
--> statement-breakpoint
ALTER TABLE "enrollment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sequence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"status" "sequence_status" DEFAULT 'draft' NOT NULL,
	"channels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window" jsonb NOT NULL,
	"created_by" text,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sequence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sequence_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"sequence_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"channel" text NOT NULL,
	"wait_days" integer DEFAULT 0 NOT NULL,
	"condition" text DEFAULT 'always' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sequence_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "step_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"step_id" uuid,
	"channel" text NOT NULL,
	"subject" text,
	"body" text,
	"written_by" text DEFAULT 'template' NOT NULL,
	"status" "message_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"connection_id" uuid,
	"external_id" text,
	"message_id" text,
	"note" text,
	"outcome" text,
	"summary" text,
	"assigned_to" text,
	"approved_by" text,
	"done_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_message_enrollmentId_stepId_unique" UNIQUE("enrollment_id","step_id")
);
--> statement-breakpoint
ALTER TABLE "step_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"list_id" uuid NOT NULL,
	"created_by" text,
	"checked_until" timestamp with time zone,
	"last_added" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watchlist" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" uuid PRIMARY KEY DEFAULT app_workspace_id() NOT NULL,
	"approval" "approval_mode" DEFAULT 'autonomous' NOT NULL,
	"sender_name" text,
	"sender_address" text,
	"mailbox_daily_cap" integer DEFAULT 40 NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "outreach" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "whatsapp_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prospect" ADD COLUMN "interest" "prospect_interest";--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_sequence_id_sequence_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_prospect_id_prospect_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospect"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_mailbox_id_connection_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step" ADD CONSTRAINT "sequence_step_sequence_id_sequence_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_step_id_sequence_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_step"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_message" ADD CONSTRAINT "step_message_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_list_id_prospect_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."prospect_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollment_workspace_id_status_next_due_at_index" ON "enrollment" USING btree ("workspace_id","status","next_due_at");--> statement-breakpoint
CREATE INDEX "enrollment_company_id_index" ON "enrollment" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "enrollment_person_id_index" ON "enrollment" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "sequence_workspace_id_status_index" ON "sequence" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "sequence_step_sequence_id_position_index" ON "sequence_step" USING btree ("sequence_id","position");--> statement-breakpoint
CREATE INDEX "step_message_workspace_id_status_index" ON "step_message" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "step_message_assigned_to_status_index" ON "step_message" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE INDEX "step_message_external_id_index" ON "step_message" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "watchlist_workspace_id_index" ON "watchlist" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "enrollment" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sequence" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sequence_step" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "step_message" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "watchlist" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspace_settings" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_settings", "sequence", "sequence_step", "enrollment", "step_message", "watchlist" TO coldlyne_app;
