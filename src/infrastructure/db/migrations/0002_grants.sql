-- What the app role may do: read workspaces and memberships (written by the trusted server path
-- only), and read and write a workspace's prospects, behind row-level security.
GRANT SELECT ON "workspace", "member" TO coldline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company", "person", "prospect_list", "prospect", "suppression" TO coldline_app;
