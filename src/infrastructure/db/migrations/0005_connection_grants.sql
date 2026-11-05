-- What the app role may do with connections: read and write a workspace's own, behind row-level
-- security. Assistants' OAuth tables stay with the owner: only Better Auth's trusted path uses them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "connection", "signal", "outreach", "api_key", "connection_grant", "contact_detail" TO coldlyne_app;
