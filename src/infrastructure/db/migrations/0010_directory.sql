-- The group: what a group of workspaces shares, so that companies and the people at them are found
-- and kept once. Screens and tools say "group"; here it is a "directory". Nothing crosses groups.
-- Everything in this file runs in one transaction, so it either all happens or none of it does.
--
-- Safe to run before the code that uses it deploys: every step below leaves what the code from
-- before this migration does working (see the two triggers), and only widens what a workspace reads
-- to its own group. Rows merged away are copied to directory_merge first, as a record to read, not a
-- way back: undoing this migration means a restore point taken before it. scripts/directory-preview.sql
-- says what it would do, and changes nothing.

-- It locks the tables it alters: better to fail and be run again than to queue behind a long
-- transaction while every request queues behind it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint

-- ─── Groups, one for each founder's workspaces ─────────────────────────────
--
-- From here on a group is chosen when a workspace starts. For what exists already, a workspace goes
-- with its oldest owner, who started it, whatever other owners it has: two owners sharing one workspace
-- must not pull each other's other workspaces into one group. A group is named after its first
-- workspace, until someone renames it.
CREATE TABLE "directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TEMP TABLE workspace_founder ON COMMIT DROP AS
  SELECT DISTINCT ON (workspace_id) workspace_id, user_id FROM "member" WHERE role = 'owner' ORDER BY workspace_id, created_at, user_id;--> statement-breakpoint
-- A workspace with no owner left shares with nobody: its own id keeps it alone.
CREATE TEMP TABLE new_group ON COMMIT DROP AS
  SELECT founder, gen_random_uuid() AS id, (array_agg(name ORDER BY created_at, id))[1] AS name FROM (
    SELECT w.id, w.name, w.created_at, coalesce(f.user_id, w.id::text) AS founder FROM "workspace" w LEFT JOIN workspace_founder f ON f.workspace_id = w.id
  ) founded GROUP BY founder;--> statement-breakpoint
INSERT INTO "directory" (id, name) SELECT id, name FROM new_group;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "directory_id" uuid;--> statement-breakpoint
UPDATE "workspace" w SET directory_id = g.id FROM new_group g WHERE g.founder = coalesce((SELECT f.user_id FROM workspace_founder f WHERE f.workspace_id = w.id), w.id::text);--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "directory_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_directory_id_directory_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."directory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_directory_id_index" ON "workspace" USING btree ("directory_id");--> statement-breakpoint
-- The bound workspace's directory, read from the database rather than a setting: it can't be claimed.
-- Definer, because the policy on "workspace" reads through it, which would otherwise never end.
CREATE FUNCTION app_directory_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT directory_id FROM workspace WHERE id = app_workspace_id() $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_directory_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_directory_id() TO coldlyne_app;--> statement-breakpoint
-- Until the code that names a group deploys: a workspace started without one is in a new one, as any is by default.
CREATE FUNCTION workspace_gets_directory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.directory_id IS NULL THEN
    INSERT INTO "directory" (name) VALUES (NEW.name) RETURNING id INTO NEW.directory_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER workspace_gets_directory BEFORE INSERT ON "workspace" FOR EACH ROW EXECUTE FUNCTION workspace_gets_directory();--> statement-breakpoint

-- ─── What is shared says which directory it is in ──────────────────────────
ALTER TABLE "company" ADD COLUMN "directory_id" uuid;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "directory_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_detail" ADD COLUMN "directory_id" uuid;--> statement-breakpoint
UPDATE "company" t SET directory_id = w.directory_id FROM "workspace" w WHERE w.id = t.workspace_id;--> statement-breakpoint
UPDATE "person" t SET directory_id = w.directory_id FROM "workspace" w WHERE w.id = t.workspace_id;--> statement-breakpoint
UPDATE "contact_detail" t SET directory_id = w.directory_id FROM "workspace" w WHERE w.id = t.workspace_id;--> statement-breakpoint
-- Rows whose workspace is gone (nothing ties them to it) stay as they are, each set in a group no workspace opens.
CREATE TEMP TABLE orphan_directory ON COMMIT DROP AS
  SELECT workspace_id, gen_random_uuid() AS directory_id FROM (
    SELECT workspace_id FROM "company" WHERE directory_id IS NULL
    UNION SELECT workspace_id FROM "person" WHERE directory_id IS NULL
    UNION SELECT workspace_id FROM "contact_detail" WHERE directory_id IS NULL
  ) missing;--> statement-breakpoint
INSERT INTO "directory" (id, name) SELECT directory_id, 'Espace retiré' FROM orphan_directory;--> statement-breakpoint
UPDATE "company" t SET directory_id = o.directory_id FROM orphan_directory o WHERE t.directory_id IS NULL AND t.workspace_id = o.workspace_id;--> statement-breakpoint
UPDATE "person" t SET directory_id = o.directory_id FROM orphan_directory o WHERE t.directory_id IS NULL AND t.workspace_id = o.workspace_id;--> statement-breakpoint
UPDATE "contact_detail" t SET directory_id = o.directory_id FROM orphan_directory o WHERE t.directory_id IS NULL AND t.workspace_id = o.workspace_id;--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "directory_id" SET DEFAULT app_directory_id();--> statement-breakpoint
ALTER TABLE "company" ALTER COLUMN "directory_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ALTER COLUMN "directory_id" SET DEFAULT app_directory_id();--> statement-breakpoint
ALTER TABLE "person" ALTER COLUMN "directory_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_detail" ALTER COLUMN "directory_id" SET DEFAULT app_directory_id();--> statement-breakpoint
ALTER TABLE "contact_detail" ALTER COLUMN "directory_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_directory_id_directory_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."directory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_directory_id_directory_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."directory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_detail" ADD CONSTRAINT "contact_detail_directory_id_directory_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."directory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_directory_id_index" ON "person" USING btree ("directory_id");--> statement-breakpoint
CREATE INDEX "contact_detail_directory_id_index" ON "contact_detail" USING btree ("directory_id");--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "registry_checked_at" timestamp with time zone;--> statement-breakpoint
UPDATE "company" SET registry_checked_at = updated_at WHERE source = 'registry';--> statement-breakpoint

-- ─── Consent stays with the business it was given to ───────────────────────
--
-- Before the same person becomes one row, or one workspace's yes would count for all of them. The
-- old column is emptied, not dropped: code from before this reads it, and treating someone as not
-- having agreed only turns a WhatsApp message into a task for a member.
CREATE TABLE "whatsapp_consent" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"agreed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "whatsapp_consent_workspace_id_person_id_pk" PRIMARY KEY("workspace_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_consent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_consent" ADD CONSTRAINT "whatsapp_consent_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "whatsapp_consent" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_consent" TO coldlyne_app;--> statement-breakpoint
INSERT INTO "whatsapp_consent" (workspace_id, person_id, agreed_at) SELECT workspace_id, id, whatsapp_consent_at FROM "person" WHERE whatsapp_consent_at IS NOT NULL;--> statement-breakpoint
UPDATE "person" SET whatsapp_consent_at = NULL WHERE whatsapp_consent_at IS NOT NULL;--> statement-breakpoint

-- ─── One company per SIREN, one person per company and name ────────────────
--
-- The oldest row stays, under its id. Everything that pointed at a row merged away points at the one
-- kept; lists, sequences and messages themselves don't change. A company without a SIREN isn't merged:
-- a name alone doesn't prove two rows are one company. People match as the code matches them, exactly.
CREATE TABLE "directory_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"row_id" uuid NOT NULL,
	"kept_id" uuid NOT NULL,
	"row" jsonb NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_merge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TEMP TABLE company_merge ON COMMIT DROP AS
  SELECT id AS row_id, kept_id FROM (
    SELECT id, first_value(id) OVER (PARTITION BY directory_id, siren ORDER BY created_at, id) AS kept_id FROM "company" WHERE siren IS NOT NULL
  ) ranked WHERE id <> kept_id;--> statement-breakpoint
CREATE TEMP TABLE person_merge ON COMMIT DROP AS
  SELECT id AS row_id, kept_id FROM (
    SELECT p.id, first_value(p.id) OVER (PARTITION BY p.directory_id, coalesce(m.kept_id, p.company_id), p.first_name, p.last_name ORDER BY p.created_at, p.id) AS kept_id
    FROM "person" p LEFT JOIN company_merge m ON m.row_id = p.company_id
  ) ranked WHERE id <> kept_id;--> statement-breakpoint
-- Two rows on one list would have to become one prospect, and each may be on its own sequence: only
-- possible for someone with no first name, whom the database can't keep unique. They stay two.
DELETE FROM person_merge m WHERE EXISTS (
  SELECT 1 FROM "prospect" mine JOIN "prospect" other ON other.list_id = mine.list_id AND other.person_id <> mine.person_id
  WHERE mine.person_id = m.row_id AND (other.person_id = m.kept_id OR other.person_id IN (SELECT row_id FROM person_merge twin WHERE twin.kept_id = m.kept_id))
);--> statement-breakpoint
INSERT INTO "directory_merge" (kind, row_id, kept_id, row) SELECT 'company', c.id, m.kept_id, to_jsonb(c) FROM "company" c JOIN company_merge m ON m.row_id = c.id;--> statement-breakpoint
INSERT INTO "directory_merge" (kind, row_id, kept_id, row) SELECT 'company', c.id, c.id, to_jsonb(c) FROM "company" c WHERE c.id IN (SELECT kept_id FROM company_merge);--> statement-breakpoint
INSERT INTO "directory_merge" (kind, row_id, kept_id, row) SELECT 'person', p.id, m.kept_id, to_jsonb(p) FROM "person" p JOIN person_merge m ON m.row_id = p.id;--> statement-breakpoint
INSERT INTO "directory_merge" (kind, row_id, kept_id, row) SELECT 'person', p.id, p.id, to_jsonb(p) FROM "person" p WHERE p.id IN (SELECT kept_id FROM person_merge);--> statement-breakpoint
-- The kept row takes the registry's latest word over a file's; a refusal of commercial use wins, whoever heard it.
UPDATE "company" kept SET
    name = best.name, legal_form = best.legal_form, activity = best.activity, street = best.street, postcode = best.postcode, city = best.city, created_on = best.created_on,
    website = best.website, registry_opt_out = best.registry_opt_out, registry_checked_at = best.registry_checked_at, source = best.source
  FROM (
    SELECT g.kept_id,
      (array_agg(c.name ORDER BY c.source = 'registry' DESC, c.updated_at DESC))[1] AS name,
      (array_agg(c.legal_form ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.legal_form IS NOT NULL))[1] AS legal_form,
      (array_agg(c.activity ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.activity IS NOT NULL))[1] AS activity,
      (array_agg(c.street ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.street IS NOT NULL))[1] AS street,
      (array_agg(c.postcode ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.postcode IS NOT NULL))[1] AS postcode,
      (array_agg(c.city ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.city IS NOT NULL))[1] AS city,
      (array_agg(c.created_on ORDER BY c.source = 'registry' DESC, c.updated_at DESC) FILTER (WHERE c.created_on IS NOT NULL))[1] AS created_on,
      (array_agg(c.website ORDER BY c.created_at) FILTER (WHERE c.website IS NOT NULL))[1] AS website,
      bool_or(c.registry_opt_out) AS registry_opt_out,
      max(c.registry_checked_at) AS registry_checked_at,
      (array_agg(c.source ORDER BY c.source = 'registry' DESC, c.created_at))[1] AS source
    FROM "company" c JOIN (SELECT row_id, kept_id FROM company_merge UNION ALL SELECT DISTINCT kept_id, kept_id FROM company_merge) g ON g.row_id = c.id
    GROUP BY g.kept_id
  ) best WHERE kept.id = best.kept_id;--> statement-breakpoint
UPDATE "person" kept SET role = best.role, companies_directed = best.companies_directed, source = best.source
  FROM (
    SELECT g.kept_id,
      (array_agg(p.role ORDER BY p.source = 'registry' DESC, p.created_at DESC) FILTER (WHERE p.role IS NOT NULL))[1] AS role,
      (array_agg(p.companies_directed ORDER BY p.created_at DESC) FILTER (WHERE p.companies_directed IS NOT NULL))[1] AS companies_directed,
      (array_agg(p.source ORDER BY p.source = 'registry' DESC, p.created_at))[1] AS source
    FROM "person" p JOIN (SELECT row_id, kept_id FROM person_merge UNION ALL SELECT DISTINCT kept_id, kept_id FROM person_merge) g ON g.row_id = p.id
    GROUP BY g.kept_id
  ) best WHERE kept.id = best.kept_id;--> statement-breakpoint
-- Comes off first: two workspaces may hold the same address for what is now one person, until the duplicates go below.
ALTER TABLE "contact_detail" DROP CONSTRAINT "contact_detail_personId_kind_value_unique";--> statement-breakpoint
UPDATE "prospect" t SET person_id = m.kept_id FROM person_merge m WHERE t.person_id = m.row_id;--> statement-breakpoint
UPDATE "enrollment" t SET person_id = m.kept_id FROM person_merge m WHERE t.person_id = m.row_id;--> statement-breakpoint
UPDATE "enrollment" t SET company_id = m.kept_id FROM company_merge m WHERE t.company_id = m.row_id;--> statement-breakpoint
UPDATE "contact_detail" t SET person_id = m.kept_id FROM person_merge m WHERE t.person_id = m.row_id;--> statement-breakpoint
INSERT INTO "whatsapp_consent" (workspace_id, person_id, agreed_at) SELECT c.workspace_id, m.kept_id, c.agreed_at FROM "whatsapp_consent" c JOIN person_merge m ON m.row_id = c.person_id ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "whatsapp_consent" c USING person_merge m WHERE c.person_id = m.row_id;--> statement-breakpoint
DELETE FROM "person" t USING person_merge m WHERE t.id = m.row_id;--> statement-breakpoint
UPDATE "person" t SET company_id = m.kept_id FROM company_merge m WHERE t.company_id = m.row_id;--> statement-breakpoint
DELETE FROM "company" t USING company_merge m WHERE t.id = m.row_id;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_directoryId_siren_unique" UNIQUE("directory_id","siren");--> statement-breakpoint

-- ─── A detail once per person: what's published once, what's private once per workspace ─
CREATE TEMP TABLE detail_merge ON COMMIT DROP AS
  SELECT id AS row_id, kept_id FROM (
    SELECT id, first_value(id) OVER (PARTITION BY person_id, kind, value, CASE WHEN page IS NULL THEN workspace_id END ORDER BY created_at, id) AS kept_id FROM "contact_detail"
  ) ranked WHERE id <> kept_id;--> statement-breakpoint
INSERT INTO "directory_merge" (kind, row_id, kept_id, row) SELECT 'contact_detail', d.id, m.kept_id, to_jsonb(d) FROM "contact_detail" d JOIN detail_merge m ON m.row_id = d.id;--> statement-breakpoint
DELETE FROM "contact_detail" t USING detail_merge m WHERE t.id = m.row_id;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_detail_person_id_kind_value_index" ON "contact_detail" USING btree ("person_id","kind","value") WHERE page is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_detail_workspace_id_person_id_kind_value_index" ON "contact_detail" USING btree ("workspace_id","person_id","kind","value") WHERE page is null;--> statement-breakpoint

-- ─── Whoever a workspace already refused, it stops writing to ──────────────
--
-- Merging gives someone the addresses other workspaces found, so a sequence running on one address may
-- now hold one this workspace was told not to use. Not its bounces: a step may be written for those.
CREATE TEMP TABLE refused_enrollment ON COMMIT DROP AS
  SELECT DISTINCT e.id FROM "enrollment" e
  JOIN "contact_detail" d ON d.person_id = e.person_id AND (d.page IS NOT NULL OR d.workspace_id = e.workspace_id)
  JOIN "suppression" s ON s.workspace_id = e.workspace_id AND s.reason <> 'bounced' AND s.value IN (d.value, split_part(d.value, '@', 2))
  WHERE e.status IN ('active', 'waiting_member');--> statement-breakpoint
UPDATE "enrollment" SET status = 'stopped', stop_reason = 'suppressed', next_due_at = NULL WHERE id IN (SELECT id FROM refused_enrollment);--> statement-breakpoint
UPDATE "step_message" SET status = 'skipped', note = 'Annulé : l’adresse est sur la liste d’exclusion.'
  WHERE enrollment_id IN (SELECT id FROM refused_enrollment) AND status IN ('draft', 'awaiting_approval', 'approved', 'to_do');--> statement-breakpoint

-- ─── Who reads what ────────────────────────────────────────────────────────
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "directory_isolation" ON "workspace" AS PERMISSIVE FOR SELECT TO "coldlyne_app" USING ("workspace"."directory_id" = (select app_directory_id()));--> statement-breakpoint
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "company" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "person" CASCADE;--> statement-breakpoint
CREATE POLICY "directory_isolation" ON "company" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("directory_id" = (select app_directory_id())) WITH CHECK ("directory_id" = (select app_directory_id()));--> statement-breakpoint
CREATE POLICY "directory_isolation" ON "person" AS PERMISSIVE FOR ALL TO "coldlyne_app" USING ("directory_id" = (select app_directory_id())) WITH CHECK ("directory_id" = (select app_directory_id()));--> statement-breakpoint
ALTER POLICY "tenant_isolation" ON "contact_detail" TO "coldlyne_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id() and "directory_id" = (select app_directory_id()));--> statement-breakpoint
CREATE POLICY "published_in_directory" ON "contact_detail" AS PERMISSIVE FOR SELECT TO "coldlyne_app" USING ("contact_detail"."page" is not null and "contact_detail"."directory_id" = (select app_directory_id()));--> statement-breakpoint
-- An opt-out stays in its workspace, under the policy it already has. Only a bounce is read across the directory: it says the address doesn't work, whoever wrote.
CREATE POLICY "directory_bounces" ON "suppression" AS PERMISSIVE FOR SELECT TO "coldlyne_app" USING ("suppression"."reason" = 'bounced' and "suppression"."workspace_id" in (select id from workspace where directory_id = (select app_directory_id())));--> statement-breakpoint
-- A shared row can't be deleted from one workspace: the cascade would take other workspaces' lists and sequences with it.
REVOKE DELETE ON "company", "person", "contact_detail" FROM coldlyne_app;--> statement-breakpoint
-- Until the code that names a directory deploys, it still adds a company by workspace and SIREN: it is given the directory's row to find.
CREATE FUNCTION company_finds_directory_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  first_workspace uuid;
BEGIN
  SELECT workspace_id INTO first_workspace FROM "company" WHERE directory_id = NEW.directory_id AND siren = NEW.siren;
  IF FOUND THEN
    NEW.workspace_id := first_workspace;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER company_finds_directory_row BEFORE INSERT ON "company" FOR EACH ROW EXECUTE FUNCTION company_finds_directory_row();--> statement-breakpoint

-- ─── What another workspace of the directory may know of someone ───────────
--
-- That it wrote to them and when, that they opted out of it and when: the bare facts a member needs
-- to decide knowingly, and no way to its messages, addresses or lists. Definer, because row-level
-- security rightly hides those tables; the directory and the workspace asking are read from the
-- binding, so no argument can reach further.
CREATE FUNCTION elsewhere_in_directory(people uuid[])
  RETURNS TABLE (person_id uuid, person text, workspace text, written_at timestamp with time zone, opted_out_at timestamp with time zone)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  WITH sibling AS (
    SELECT id, name FROM workspace WHERE directory_id = app_directory_id() AND id <> app_workspace_id()
  ), asked AS (
    SELECT id, trim(coalesce(first_name, '') || ' ' || last_name) AS name FROM person WHERE id = ANY(people) AND directory_id = app_directory_id()
  ), written AS (
    SELECT e.workspace_id, e.person_id, max(o.sent_at) AS at
    FROM outreach o JOIN enrollment e ON e.id = o.enrollment_id
    WHERE e.person_id IN (SELECT id FROM asked) AND e.workspace_id IN (SELECT id FROM sibling)
    GROUP BY 1, 2
  ), refused AS (
    SELECT workspace_id, person_id, max(at) AS at FROM (
      SELECT p.workspace_id, p.person_id, p.updated_at AS at FROM prospect p
      WHERE p.state = 'opted_out' AND p.person_id IN (SELECT id FROM asked) AND p.workspace_id IN (SELECT id FROM sibling)
      UNION ALL
      SELECT s.workspace_id, d.person_id, s.created_at FROM suppression s JOIN contact_detail d ON s.value IN (d.value, split_part(d.value, '@', 2))
      WHERE s.reason IN ('opted_out', 'asked') AND d.person_id IN (SELECT id FROM asked) AND s.workspace_id IN (SELECT id FROM sibling) AND (d.page IS NOT NULL OR d.workspace_id = s.workspace_id)
    ) said GROUP BY 1, 2
  )
  SELECT a.id, a.name, w.name, wr.at, r.at
  FROM asked a CROSS JOIN sibling w
  LEFT JOIN written wr ON wr.person_id = a.id AND wr.workspace_id = w.id
  LEFT JOIN refused r ON r.person_id = a.id AND r.workspace_id = w.id
  WHERE wr.at IS NOT NULL OR r.at IS NOT NULL
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION elsewhere_in_directory(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION elsewhere_in_directory(uuid[]) TO coldlyne_app;
