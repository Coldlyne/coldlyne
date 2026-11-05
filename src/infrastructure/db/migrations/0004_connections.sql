CREATE TYPE "public"."connection_status" AS ENUM('connected', 'failing');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('replied', 'auto_reply', 'bounced', 'opted_out', 'delivered', 'failed', 'answered', 'no_answer', 'voicemail_left', 'meeting_booked', 'meeting_cancelled', 'signed_up');--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"status" "connection_status" DEFAULT 'connected' NOT NULL,
	"sealed_credentials" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hook_token" text NOT NULL,
	"connected_by" text,
	"checked_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_workspaceId_kind_label_unique" UNIQUE("workspace_id","kind","label")
);
--> statement-breakpoint
ALTER TABLE "connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connection_grant" (
	"state" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"kind" text NOT NULL,
	"code_verifier" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"connection_id" uuid,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"message_id" text,
	"external_id" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"connection_id" uuid,
	"type" "signal_type" NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"address" text,
	"at" timestamp with time zone NOT NULL,
	"detail" text,
	"in_reply_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_connectionId_externalId_unique" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "signal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_detail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"page" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_detail_personId_kind_value_unique" UNIQUE("person_id","kind","value")
);
--> statement-breakpoint
ALTER TABLE "contact_detail" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant" ADD CONSTRAINT "connection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal" ADD CONSTRAINT "signal_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_detail" ADD CONSTRAINT "contact_detail_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_index" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_index" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_index" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_key_workspace_id_index" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outreach_workspace_id_address_index" ON "outreach" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "outreach_workspace_id_message_id_index" ON "outreach" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "signal_workspace_id_address_index" ON "signal" USING btree ("workspace_id","address");--> statement-breakpoint
CREATE INDEX "contact_detail_workspace_id_index" ON "contact_detail" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_key" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connection" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connection_grant" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outreach" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "signal" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_detail" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());