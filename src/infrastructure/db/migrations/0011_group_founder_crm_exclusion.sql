-- Adds only: an allowed reason for an exclusion, and who started each group. Safe before the code that
-- uses them deploys, which keeps working with both left alone.

-- It locks the tables it alters: better to fail and be run again than to queue behind a long
-- transaction while every request queues behind it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TYPE "public"."suppression_reason" ADD VALUE 'crm';--> statement-breakpoint
ALTER TABLE "directory" ADD COLUMN "founder_id" text;--> statement-breakpoint
ALTER TABLE "directory" ADD CONSTRAINT "directory_founder_id_user_id_fk" FOREIGN KEY ("founder_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A group from before this was kept: the oldest owner of its first workspace, which is how migration
-- 0010 formed groups. A group with no owner left stays without one until someone owns a workspace of it.
UPDATE "directory" d SET founder_id = (
  SELECT m.user_id FROM "workspace" w JOIN "member" m ON m.workspace_id = w.id AND m.role = 'owner'
  WHERE w.directory_id = d.id ORDER BY w.created_at, w.id, m.created_at, m.user_id LIMIT 1
);
