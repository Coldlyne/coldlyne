-- What a database looks like before the directory: several workspaces, the same companies found
-- again and again, sequences under way. Made-up names throughout. The migration test and the run
-- against a real Postgres both start from this.

INSERT INTO "user" (id, name, email, email_verified) VALUES
  ('ada', 'Ada', 'ada@northwind.example', true),
  ('bea', 'Bea', 'bea@fabrikam.example', true),
  ('cleo', 'Cleo', 'cleo@contoso.example', true),
  ('dan', 'Dan', 'dan@northwind.example', true);

INSERT INTO workspace (id, name, slug) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Northwind', 'northwind-a1'),
  ('a2000000-0000-4000-8000-000000000002', 'Northwind Conseil', 'northwind-a2'),
  ('a3000000-0000-4000-8000-000000000003', 'Northwind Studio', 'northwind-a3'),
  ('b1000000-0000-4000-8000-000000000001', 'Fabrikam', 'fabrikam-b1'),
  ('c1000000-0000-4000-8000-000000000001', 'Contoso', 'contoso-c1'),
  ('d1000000-0000-4000-8000-000000000001', 'Nobody''s', 'nobody-d1');

-- Ada founded three; Cleo also owns the third, and has one of her own, which must not join Ada's. Dan is a plain member of one.
INSERT INTO member (workspace_id, user_id, role, created_at) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'ada', 'owner', '2026-10-01'),
  ('a2000000-0000-4000-8000-000000000002', 'ada', 'owner', '2026-10-02'),
  ('a3000000-0000-4000-8000-000000000003', 'ada', 'owner', '2026-10-03'),
  ('a3000000-0000-4000-8000-000000000003', 'cleo', 'owner', '2026-10-05'),
  ('a2000000-0000-4000-8000-000000000002', 'dan', 'member', '2026-10-06'),
  ('b1000000-0000-4000-8000-000000000001', 'bea', 'owner', '2026-10-01'),
  ('c1000000-0000-4000-8000-000000000001', 'cleo', 'owner', '2026-10-04');

INSERT INTO company (id, workspace_id, siren, name, legal_form, activity, street, postcode, city, created_on, website, registry_opt_out, source, created_at, updated_at) VALUES
  -- The same SIREN in three of Ada's workspaces: the first has no website, the file a newer name.
  ('c0000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '900000001', 'ACME HOLDING', '5710', '64.20Z', '1 rue de la Paix', '69002', 'LYON', '2019-03-01', NULL, false, 'registry', '2026-10-10', '2026-10-12'),
  ('c0000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '900000001', 'Acme', NULL, NULL, NULL, NULL, NULL, NULL, 'https://acme.example', false, 'import', '2026-10-11', '2026-10-11'),
  ('c0000001-0000-4000-8000-0000000000a3', 'a3000000-0000-4000-8000-000000000003', '900000001', 'ACME HOLDING SAS', '5710', '64.20Z', '2 rue de la Paix', '69002', 'LYON', '2019-03-01', 'https://other.acme.example', false, 'registry', '2026-10-13', '2026-10-14'),
  -- The same SIREN in two owners' workspaces: never one row.
  ('c0000002-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '900000002', 'SHARED NAME', '5710', NULL, NULL, NULL, NULL, NULL, NULL, false, 'registry', '2026-10-10', '2026-10-10'),
  ('c0000002-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001', '900000002', 'SHARED NAME', '5710', NULL, NULL, NULL, NULL, NULL, NULL, false, 'registry', '2026-10-10', '2026-10-10'),
  -- One copy heard the company refuse commercial use of its data.
  ('c0000003-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '900000003', 'REFUSING SAS', '5710', NULL, NULL, NULL, NULL, NULL, NULL, false, 'registry', '2026-10-10', '2026-10-10'),
  ('c0000003-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '900000003', 'REFUSING SAS', '5710', NULL, NULL, NULL, NULL, NULL, NULL, true, 'registry', '2026-10-11', '2026-10-11'),
  -- Only in one workspace, and two companies with one name and no SIREN, which nothing proves are one.
  ('c0000004-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '900000004', 'ALONE SARL', '5499', NULL, NULL, NULL, NULL, NULL, NULL, false, 'registry', '2026-10-10', '2026-10-10'),
  ('c0000005-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', NULL, 'Dupont Conseil', NULL, NULL, NULL, NULL, 'LYON', NULL, NULL, false, 'import', '2026-10-10', '2026-10-10'),
  ('c0000005-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', NULL, 'Dupont Conseil', NULL, NULL, NULL, NULL, 'PARIS', NULL, NULL, false, 'import', '2026-10-11', '2026-10-11'),
  -- Left behind by a workspace removed by hand: nothing ties a row to its workspace.
  ('c0000006-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-000000000001', '900000006', 'FORGOTTEN SAS', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, 'registry', '2026-10-10', '2026-10-10');

INSERT INTO person (id, workspace_id, company_id, first_name, last_name, role, source, whatsapp_consent_at, created_at) VALUES
  ('e0000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'c0000001-0000-4000-8000-0000000000a1', 'Jeanne', 'Martin', 'Présidente', 'registry', NULL, '2026-10-10'),
  ('e0000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'c0000001-0000-4000-8000-0000000000a2', 'Jeanne', 'Martin', NULL, 'import', '2026-10-20', '2026-10-11'),
  ('e0000001-0000-4000-8000-0000000000a3', 'a3000000-0000-4000-8000-000000000003', 'c0000001-0000-4000-8000-0000000000a3', 'Jeanne', 'Martin', 'Présidente', 'registry', NULL, '2026-10-13'),
  -- Only one workspace knows him: he moves to the kept company, as himself.
  ('e0000002-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'c0000001-0000-4000-8000-0000000000a2', 'Paul', 'Durand', 'Directeur', 'import', NULL, '2026-10-11'),
  ('e0000003-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'c0000002-0000-4000-8000-0000000000a1', 'Jeanne', 'Martin', 'Gérante', 'registry', NULL, '2026-10-10'),
  ('e0000003-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001', 'c0000002-0000-4000-8000-0000000000b1', 'Jeanne', 'Martin', 'Gérante', 'registry', NULL, '2026-10-10'),
  ('e0000004-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'c0000003-0000-4000-8000-0000000000a1', 'Luc', 'Blanc', 'Président', 'registry', NULL, '2026-10-10'),
  ('e0000004-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'c0000003-0000-4000-8000-0000000000a2', 'Luc', 'Blanc', 'Président', 'registry', NULL, '2026-10-11'),
  -- No first name, twice on one list: the database can't keep these unique, and they can't become one prospect.
  ('e0000005-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-000000000002', 'c0000004-0000-4000-8000-0000000000a2', NULL, 'Noir', NULL, 'import', NULL, '2026-10-10'),
  ('e0000005-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'c0000004-0000-4000-8000-0000000000a2', NULL, 'Noir', NULL, 'import', NULL, '2026-10-11'),
  ('e0000006-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'c0000005-0000-4000-8000-0000000000a1', 'Ana', 'Dupont', NULL, 'import', NULL, '2026-10-10'),
  ('e0000006-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'c0000005-0000-4000-8000-0000000000a2', 'Ana', 'Dupont', NULL, 'import', NULL, '2026-10-11'),
  ('e0000007-0000-4000-8000-0000000000e1', 'e1000000-0000-4000-8000-000000000001', 'c0000006-0000-4000-8000-0000000000e1', 'Eva', 'Vert', NULL, 'registry', NULL, '2026-10-10');

INSERT INTO contact_detail (id, workspace_id, person_id, kind, value, page, source, created_at) VALUES
  -- Two workspaces confirmed the same published address.
  ('d0000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'e0000001-0000-4000-8000-0000000000a1', 'email', 'jeanne@acme.example', 'https://acme.example/contact', 'website', '2026-10-15'),
  ('d0000001-0000-4000-8000-0000000000a3', 'a3000000-0000-4000-8000-000000000003', 'e0000001-0000-4000-8000-0000000000a3', 'email', 'jeanne@acme.example', 'https://acme.example/equipe', 'website', '2026-10-16'),
  -- One workspace's own file: stays its own, even with the same value as what's published.
  ('d0000002-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'e0000001-0000-4000-8000-0000000000a2', 'email', 'jeanne@acme.example', NULL, 'import', '2026-10-17'),
  ('d0000003-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'e0000001-0000-4000-8000-0000000000a2', 'phone', '+33612345678', NULL, 'import', '2026-10-17'),
  ('d0000004-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'e0000002-0000-4000-8000-0000000000a2', 'email', 'paul@acme.example', 'https://acme.example/equipe', 'website', '2026-10-17'),
  ('d0000005-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001', 'e0000003-0000-4000-8000-0000000000b1', 'email', 'jeanne@shared.example', 'https://shared.example', 'website', '2026-10-17');

INSERT INTO prospect_list (id, workspace_id, name) VALUES
  ('f0000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Holdings'),
  ('f0000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'Conseil'),
  ('f0000002-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'Noir'),
  ('f0000001-0000-4000-8000-0000000000a3', 'a3000000-0000-4000-8000-000000000003', 'Studio'),
  ('f0000001-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001', 'Fabrikam');

INSERT INTO prospect (id, workspace_id, list_id, person_id, state, interest) VALUES
  ('10000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-0000000000a1', 'e0000001-0000-4000-8000-0000000000a1', 'in_sequence', NULL),
  ('10000002-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-0000000000a1', 'e0000003-0000-4000-8000-0000000000a1', 'new', NULL),
  ('10000003-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-0000000000a1', 'e0000004-0000-4000-8000-0000000000a1', 'new', NULL),
  ('10000004-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-0000000000a1', 'e0000006-0000-4000-8000-0000000000a1', 'new', NULL),
  ('10000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000001-0000-4000-8000-0000000000a2', 'e0000001-0000-4000-8000-0000000000a2', 'replied', 'interested'),
  ('10000002-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000001-0000-4000-8000-0000000000a2', 'e0000002-0000-4000-8000-0000000000a2', 'in_sequence', NULL),
  ('10000003-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000001-0000-4000-8000-0000000000a2', 'e0000004-0000-4000-8000-0000000000a2', 'new', NULL),
  ('10000004-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000002-0000-4000-8000-0000000000a2', 'e0000005-0000-4000-8000-0000000000a1', 'new', NULL),
  ('10000005-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000002-0000-4000-8000-0000000000a2', 'e0000005-0000-4000-8000-0000000000a2', 'new', NULL),
  ('10000006-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'f0000001-0000-4000-8000-0000000000a2', 'e0000006-0000-4000-8000-0000000000a2', 'new', NULL),
  ('10000001-0000-4000-8000-0000000000a3', 'a3000000-0000-4000-8000-000000000003', 'f0000001-0000-4000-8000-0000000000a3', 'e0000001-0000-4000-8000-0000000000a3', 'new', NULL),
  ('10000001-0000-4000-8000-0000000000b1', 'b1000000-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-0000000000b1', 'e0000003-0000-4000-8000-0000000000b1', 'new', NULL);

INSERT INTO sequence (id, workspace_id, name, status, "window") VALUES
  ('20000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', 'Holdings', 'running', '{"days":[1,2,3,4,5],"from":"09:00","to":"17:00","timezone":"Europe/Paris"}'),
  ('20000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', 'Conseil', 'running', '{"days":[1,2,3,4,5],"from":"09:00","to":"17:00","timezone":"Europe/Paris"}');

INSERT INTO sequence_step (id, workspace_id, sequence_id, position, channel, body) VALUES
  ('30000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '20000001-0000-4000-8000-0000000000a1', 0, 'email', 'Une idée pour {{company}}.'),
  ('30000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '20000001-0000-4000-8000-0000000000a2', 0, 'email', 'Une autre idée.');

INSERT INTO enrollment (id, workspace_id, sequence_id, prospect_id, person_id, company_id, status, next_due_at) VALUES
  ('40000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '20000001-0000-4000-8000-0000000000a1', '10000001-0000-4000-8000-0000000000a1', 'e0000001-0000-4000-8000-0000000000a1', 'c0000001-0000-4000-8000-0000000000a1', 'active', '2026-11-20'),
  ('40000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '20000001-0000-4000-8000-0000000000a2', '10000001-0000-4000-8000-0000000000a2', 'e0000001-0000-4000-8000-0000000000a2', 'c0000001-0000-4000-8000-0000000000a2', 'stopped', NULL),
  ('40000002-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '20000001-0000-4000-8000-0000000000a2', '10000002-0000-4000-8000-0000000000a2', 'e0000002-0000-4000-8000-0000000000a2', 'c0000001-0000-4000-8000-0000000000a2', 'active', '2026-11-20');

INSERT INTO step_message (id, workspace_id, enrollment_id, step_id, channel, subject, body, status, sent_at) VALUES
  ('50000001-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-000000000001', '40000001-0000-4000-8000-0000000000a1', '30000001-0000-4000-8000-0000000000a1', 'email', 'Bonjour', 'Écrit pour Jeanne.', 'draft', NULL),
  ('50000001-0000-4000-8000-0000000000a2', 'a2000000-0000-4000-8000-000000000002', '40000001-0000-4000-8000-0000000000a2', '30000001-0000-4000-8000-0000000000a2', 'email', 'Bonjour', 'Déjà parti.', 'sent', '2026-10-20');

INSERT INTO outreach (workspace_id, channel, address, enrollment_id, sent_at) VALUES
  ('a2000000-0000-4000-8000-000000000002', 'email', 'jeanne@acme.example', '40000001-0000-4000-8000-0000000000a2', '2026-10-20');

INSERT INTO signal (workspace_id, type, channel, external_id, address, at, detail) VALUES
  ('a2000000-0000-4000-8000-000000000002', 'replied', 'email', 'reply-1', 'jeanne@acme.example', '2026-10-21', 'Volontiers');

INSERT INTO suppression (workspace_id, value, reason) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'client.example', 'member'),
  ('a1000000-0000-4000-8000-000000000001', 'stop@acme.example', 'opted_out'),
  ('a2000000-0000-4000-8000-000000000002', 'asked@acme.example', 'asked'),
  ('a2000000-0000-4000-8000-000000000002', 'dead@acme.example', 'bounced'),
  ('b1000000-0000-4000-8000-000000000001', 'dead@fabrikam.example', 'bounced');
