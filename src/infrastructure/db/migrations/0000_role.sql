-- Tenant isolation: a workspace's data is read and written as the restricted role coldline_app,
-- with the workspace set per transaction (app.workspace_id). It comes first: the tables' policies name it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coldline_app') THEN
    CREATE ROLE coldline_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT coldline_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO coldline_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_workspace_id() TO coldline_app;
