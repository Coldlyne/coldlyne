CREATE TYPE "public"."prospect_source" AS ENUM('registry', 'import', 'member');--> statement-breakpoint
CREATE TYPE "public"."prospect_state" AS ENUM('new', 'ready', 'in_sequence', 'replied', 'bounced', 'opted_out', 'done');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('opted_out', 'bounced', 'asked', 'member');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"siren" text,
	"name" text NOT NULL,
	"legal_form" text,
	"activity" text,
	"postcode" text,
	"city" text,
	"created_on" text,
	"website" text,
	"registry_opt_out" boolean DEFAULT false NOT NULL,
	"source" "prospect_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_workspaceId_siren_unique" UNIQUE("workspace_id","siren")
);
--> statement-breakpoint
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text NOT NULL,
	"role" text,
	"companies_directed" integer,
	"source" "prospect_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_companyId_firstName_lastName_unique" UNIQUE("company_id","first_name","last_name")
);
--> statement-breakpoint
ALTER TABLE "person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prospect" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"list_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"state" "prospect_state" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospect_listId_personId_unique" UNIQUE("list_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "prospect" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prospect_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prospect_list" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"value" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_workspaceId_value_unique" UNIQUE("workspace_id","value")
);
--> statement-breakpoint
ALTER TABLE "suppression" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect" ADD CONSTRAINT "prospect_list_id_prospect_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."prospect_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect" ADD CONSTRAINT "prospect_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "person_workspace_id_index" ON "person" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "prospect_list_workspace_id_index" ON "prospect_list" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "company" AS PERMISSIVE FOR ALL TO "coldline_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "person" AS PERMISSIVE FOR ALL TO "coldline_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "prospect" AS PERMISSIVE FOR ALL TO "coldline_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "prospect_list" AS PERMISSIVE FOR ALL TO "coldline_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "suppression" AS PERMISSIVE FOR ALL TO "coldline_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());