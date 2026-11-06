-- Read-only: what migration 0010 (the groups) would do to this database, before anyone runs it. It
-- changes nothing. Run it by hand, against a database still at migration 0009. It names workspaces, so
-- keep what it answers to whoever runs this database. landing_together is the one to read first:
-- workspaces with one oldest owner become one group, and what merges there can't be told apart again.
WITH founder AS (
  SELECT DISTINCT ON (workspace_id) workspace_id, user_id FROM "member" WHERE role = 'owner' ORDER BY workspace_id, created_at, user_id
), placed AS (
  SELECT w.id AS workspace_id, w.name, w.created_at, coalesce(f.user_id, w.id::text) AS grouped_by FROM workspace w LEFT JOIN founder f ON f.workspace_id = w.id
), groups AS (
  SELECT (array_agg(name ORDER BY created_at, workspace_id))[1] AS named, json_agg(name ORDER BY created_at, workspace_id) AS workspaces FROM placed GROUP BY grouped_by
), companies AS (
  SELECT c.*, coalesce(p.grouped_by, c.workspace_id::text) AS grouped_by FROM company c LEFT JOIN placed p ON p.workspace_id = c.workspace_id
), company_merge AS (
  SELECT id AS row_id, kept FROM (
    SELECT id, first_value(id) OVER (PARTITION BY grouped_by, siren ORDER BY created_at, id) AS kept FROM companies WHERE siren IS NOT NULL
  ) ranked WHERE id <> kept
), person_rank AS (
  SELECT id AS row_id, kept FROM (
    SELECT p.id, first_value(p.id) OVER (PARTITION BY c.grouped_by, coalesce(m.kept, p.company_id), p.first_name, p.last_name ORDER BY p.created_at, p.id) AS kept
    FROM person p JOIN companies c ON c.id = p.company_id LEFT JOIN company_merge m ON m.row_id = p.company_id
  ) ranked WHERE id <> kept
), person_merge AS (
  -- Two rows on one list stay two, as the migration leaves them: they can't become one prospect.
  SELECT m.row_id, m.kept FROM person_rank m WHERE NOT EXISTS (
    SELECT 1 FROM prospect mine JOIN prospect other ON other.list_id = mine.list_id AND other.person_id <> mine.person_id
    WHERE mine.person_id = m.row_id AND (other.person_id = m.kept OR other.person_id IN (SELECT twin.row_id FROM person_rank twin WHERE twin.kept = m.kept))
  )
), details AS (
  SELECT d.*, coalesce(m.kept, d.person_id) AS kept_person FROM contact_detail d LEFT JOIN person_merge m ON m.row_id = d.person_id
), detail_merge AS (
  SELECT id AS row_id FROM (
    SELECT id, first_value(id) OVER (PARTITION BY kept_person, kind, value, CASE WHEN page IS NULL THEN workspace_id END ORDER BY created_at, id) AS kept FROM details
  ) ranked WHERE id <> kept
), refused_enrollment AS (
  SELECT DISTINCT e.id FROM enrollment e
  LEFT JOIN person_merge m ON m.row_id = e.person_id
  JOIN details d ON d.kept_person = coalesce(m.kept, e.person_id) AND (d.page IS NOT NULL OR d.workspace_id = e.workspace_id)
  JOIN suppression s ON s.workspace_id = e.workspace_id AND s.reason <> 'bounced' AND s.value IN (d.value, split_part(d.value, '@', 2))
  WHERE e.status IN ('active', 'waiting_member')
)
SELECT
  (SELECT json_agg(json_build_object('group', named, 'workspaces', workspaces)) FROM groups) AS landing_together,
  (SELECT count(*) FROM workspace) AS workspaces,
  (SELECT count(*) FROM groups) AS groups,
  (SELECT count(*) FROM company) AS companies,
  (SELECT count(*) FROM company_merge) AS companies_merged_away,
  (SELECT count(*) FROM person) AS people,
  (SELECT count(*) FROM person_merge) AS people_merged_away,
  (SELECT count(*) FROM person_rank) - (SELECT count(*) FROM person_merge) AS people_left_as_two_on_one_list,
  (SELECT count(*) FROM contact_detail) AS contact_details,
  (SELECT count(*) FROM detail_merge) AS contact_details_merged_away,
  (SELECT count(*) FROM contact_detail WHERE page IS NULL) AS contact_details_staying_private,
  (SELECT count(*) FROM company WHERE siren IS NULL) AS companies_without_siren_left_alone,
  (SELECT count(*) FROM person WHERE whatsapp_consent_at IS NOT NULL) AS whatsapp_consents_moved,
  (SELECT count(*) FROM refused_enrollment) AS running_enrollments_stopped_for_a_suppressed_detail,
  (SELECT count(*) FROM suppression WHERE reason = 'bounced') AS bounces_read_across_their_group,
  (SELECT count(*) FROM suppression WHERE reason <> 'bounced') AS suppressions_staying_in_their_workspace,
  (SELECT count(*) FROM prospect) AS prospects_unchanged;
