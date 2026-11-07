import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { contactsOf } from "@/application/contacts";
import { suppressedIn } from "@/application/enrollments";
import { addFromRegistry, createList, prospectsOf, suppressedOf } from "@/application/prospects";
import { figuresOf } from "@/application/figures";
import { groupsOwnedBy } from "@/application/groups";
import { createWorkspace } from "@/application/workspaces";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { databaseBeforeDirectory, rowsOf } from "./support/database";
import { holding } from "./support/registry";

const [A1, A2, A3] = ["a1000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000002", "a3000000-0000-4000-8000-000000000003"];
const [B1, C1, D1] = ["b1000000-0000-4000-8000-000000000001", "c1000000-0000-4000-8000-000000000001", "d1000000-0000-4000-8000-000000000001"];
const WORKSPACES = [A1, A2, A3, B1, C1, D1];
const SINCE = new Date("2026-01-01");

const rows = async (db: Database, query: ReturnType<typeof sql>) => rowsOf(await db.execute(query));

let db: Database;
let figuresBefore: Record<string, unknown>;
let prospectsBefore: Record<string, unknown>[];
let previewed: Record<string, unknown>;

const PREVIEW = sql.raw(readFileSync("scripts/directory-preview.sql", "utf8"));
const MIGRATION = readFileSync("src/infrastructure/db/migrations/0010_directory.sql", "utf8");

beforeAll(async () => {
  const before = await databaseBeforeDirectory();
  db = before.db;
  figuresBefore = Object.fromEntries(await Promise.all(WORKSPACES.map(async (id) => [id, await figuresOf(db, id, SINCE)])));
  prospectsBefore = await rows(db, sql`select id, workspace_id, list_id, state, interest from prospect order by id`);
  [previewed] = await rows(db, PREVIEW);
  await before.finishMigrating();
}, 120_000);

describe("who shares with whom", () => {
  const groups = async () => Object.fromEntries((await rows(db, sql`select w.id, d.id as group_id, d.name from workspace w join directory d on d.id = w.directory_id where w.id in (${sql.join(WORKSPACES.map((id) => sql`${id}`), sql`, `)})`)).map(({ id, group_id, name }) => [id as string, { group: group_id, name }]));

  it("makes one founder's workspaces one group, and each other's apart", async () => {
    const found = await groups();
    expect(found[A2].group).toBe(found[A1].group);
    expect(found[A3].group).toBe(found[A1].group);
    expect(new Set([A1, B1, C1, D1].map((id) => found[id].group)).size).toBe(4);
  });

  it("follows the oldest owner: someone sharing a workspace doesn't pull their own into it", async () => {
    const found = await groups();
    expect(found[C1].group).not.toBe(found[A3].group);
  });

  it("keeps who started each group: the oldest owner of its first workspace", async () => {
    const founders = await rows(db, sql`select w.id, d.founder_id from workspace w join directory d on d.id = w.directory_id where w.id in (${sql.join([A3, C1, D1].map((id) => sql`${id}`), sql`, `)})`);
    expect(Object.fromEntries(founders.map(({ id, founder_id }) => [id, founder_id]))).toEqual({ [A3]: "ada", [C1]: "cleo", [D1]: null });
  });

  it("names a group after its first workspace, until someone renames it", async () => {
    const found = await groups();
    expect(found[A1].name).toBe("Northwind");
    expect(found[A3].name).toBe("Northwind");
    expect(found[C1].name).toBe("Contoso");
    expect(found[D1].name).toBe("Nobody's");
  });

  it("leaves rows whose workspace is gone where no workspace opens them", async () => {
    const [forgotten] = await rows(db, sql`select directory_id from company where siren = '900000006'`);
    expect(forgotten.directory_id).toEqual(expect.any(String));
    for (const id of WORKSPACES) expect(await withWorkspace(db, id, (tx) => rows(tx, sql`select id from company where siren = '900000006'`))).toEqual([]);
  });
});

describe("what the preview says", () => {
  it("says which workspaces land together", () => {
    expect(previewed.landing_together).toEqual(
      expect.arrayContaining([
        { group: "Northwind", workspaces: ["Northwind", "Northwind Conseil", "Northwind Studio"] },
        { group: "Fabrikam", workspaces: ["Fabrikam"] },
        { group: "Contoso", workspaces: ["Contoso"] },
        { group: "Nobody's", workspaces: ["Nobody's"] },
      ]),
    );
    expect(Number(previewed.groups)).toBe(4);
  });

  it("gives what the migration then does, exactly", async () => {
    const archived = await rows(db, sql`select kind, count(*)::int as count from directory_merge where row_id <> kept_id group by kind`);
    const merged = (kind: string) => archived.find((row) => row.kind === kind)?.count;
    expect(Number(previewed.companies_merged_away)).toBe(merged("company"));
    expect(Number(previewed.people_merged_away)).toBe(merged("person"));
    expect(Number(previewed.contact_details_merged_away)).toBe(merged("contact_detail"));
    expect(Number(previewed.people_left_as_two_on_one_list)).toBe(1);
  });
});

describe("the migration itself", () => {
  it("gives up rather than queue behind a long transaction, with every request queueing behind it", () => {
    expect(MIGRATION.trim().split("\n").find((line) => line.startsWith("SET LOCAL"))).toBe("SET LOCAL lock_timeout = '10s';--> statement-breakpoint");
    expect(MIGRATION.indexOf("SET LOCAL lock_timeout")).toBeLessThan(MIGRATION.indexOf("ALTER TABLE"));
  });

  it("doesn't promise a way back: that's a restore point", () => {
    expect(MIGRATION).toContain("undoing this migration means a restore point");
    expect(MIGRATION).not.toMatch(/can be undone|undo it from/i);
  });
});

describe("the duplicates", () => {
  it("become one company per SIREN in a directory, under the oldest row", async () => {
    const found = await rows(db, sql`select id, siren, name from company where siren = '900000001'`);
    expect(found).toEqual([{ id: "c0000001-0000-4000-8000-0000000000a1", siren: "900000001", name: "ACME HOLDING SAS" }]);
  });

  it("keep the registry's latest word, the first website known, and a refusal, whoever heard it", async () => {
    const [kept] = await rows(db, sql`select street, website, source, registry_checked_at from company where siren = '900000001'`);
    expect(kept).toMatchObject({ street: "2 rue de la Paix", website: "https://acme.example", source: "registry", registry_checked_at: expect.anything() });
    expect(await rows(db, sql`select registry_opt_out from company where siren = '900000003'`)).toEqual([{ registry_opt_out: true }]);
  });

  it("stay apart across owners, whatever the SIREN says", async () => {
    expect(await rows(db, sql`select id from company where siren = '900000002' order by id`)).toHaveLength(2);
    expect(await rows(db, sql`select id from person where last_name = 'Martin' and first_name = 'Jeanne' and company_id in (select id from company where siren = '900000002')`)).toHaveLength(2);
  });

  it("don't include companies with only a name in common", async () => {
    expect(await rows(db, sql`select city from company where name = 'Dupont Conseil' order by city`)).toEqual([{ city: "LYON" }, { city: "PARIS" }]);
    expect(await rows(db, sql`select id from person where first_name = 'Ana'`)).toHaveLength(2);
  });

  it("make one person per company and exact name, with what each row knew", async () => {
    expect(await rows(db, sql`select id, role, source from person where company_id = 'c0000001-0000-4000-8000-0000000000a1' order by first_name`)).toEqual([
      { id: "e0000001-0000-4000-8000-0000000000a1", role: "Présidente", source: "registry" },
      { id: "e0000002-0000-4000-8000-0000000000a2", role: "Directeur", source: "import" },
    ]);
  });

  it("leave two who can't become one prospect as two", async () => {
    expect(await rows(db, sql`select id from person where last_name = 'Noir'`)).toHaveLength(2);
    expect(await rows(db, sql`select id from prospect where list_id = 'f0000002-0000-4000-8000-0000000000a2'`)).toHaveLength(2);
  });

  it("are kept as they were, to be read: the rows merged away and the kept rows' fields from before", async () => {
    const archived = await rows(db, sql`select kind, row_id, kept_id from directory_merge where kind = 'company' and kept_id = 'c0000001-0000-4000-8000-0000000000a1' order by row_id`);
    expect(archived.map(({ row_id }) => row_id)).toEqual(["c0000001-0000-4000-8000-0000000000a1", "c0000001-0000-4000-8000-0000000000a2", "c0000001-0000-4000-8000-0000000000a3"]);
    const [{ row }] = await rows(db, sql`select row from directory_merge where row_id = 'c0000001-0000-4000-8000-0000000000a2'`);
    expect(row).toMatchObject({ name: "Acme", website: "https://acme.example", workspace_id: A2, source: "import" });
    const [{ row: person }] = await rows(db, sql`select row from directory_merge where row_id = 'e0000001-0000-4000-8000-0000000000a2'`);
    expect(person).toMatchObject({ workspace_id: A2, first_name: "Jeanne", source: "import" });
  });

  it("removed exactly what the archive holds, and nothing else", async () => {
    const removed = await rows(db, sql`select kind, count(*)::int as count from directory_merge where row_id <> kept_id group by kind order by kind`);
    // Companies: 900000001 twice, 900000003 once. People: Jeanne twice, Luc once. Details: the second published address.
    expect(removed).toEqual([
      { kind: "company", count: 3 },
      { kind: "contact_detail", count: 1 },
      { kind: "person", count: 3 },
    ]);
    expect(await rows(db, sql`select (select count(*)::int from company) as companies, (select count(*)::int from person) as people, (select count(*)::int from contact_detail) as details`)).toEqual([{ companies: 8, people: 10, details: 5 }]);
  });
});

describe("what each workspace holds", () => {
  it("keeps every prospect, on its list, in its state", async () => {
    expect(await rows(db, sql`select id, workspace_id, list_id, state, interest from prospect order by id`)).toEqual(prospectsBefore);
  });

  it("reports the same figures, to the digit: other apps read these", async () => {
    for (const id of WORKSPACES) expect(await figuresOf(db, id, SINCE), id).toEqual(figuresBefore[id]);
  });

  it("points every sequence at the kept rows, and leaves nothing dangling", async () => {
    expect(await rows(db, sql`select person_id, company_id, status from enrollment where id = '40000001-0000-4000-8000-0000000000a2'`)).toEqual([{ person_id: "e0000001-0000-4000-8000-0000000000a1", company_id: "c0000001-0000-4000-8000-0000000000a1", status: "stopped" }]);
    expect(await rows(db, sql`select body, status from step_message where id = '50000001-0000-4000-8000-0000000000a1'`)).toEqual([{ body: "Écrit pour Jeanne.", status: "draft" }]);
    expect(await rows(db, sql`select e.id from enrollment e left join person p on p.id = e.person_id left join company c on c.id = e.company_id where p.id is null or c.id is null`)).toEqual([]);
    expect(await rows(db, sql`select p.id from prospect p left join person r on r.id = p.person_id where r.id is null`)).toEqual([]);
  });

  it("keeps a WhatsApp yes with the business it was given to", async () => {
    expect(await rows(db, sql`select workspace_id, person_id from whatsapp_consent`)).toEqual([{ workspace_id: A2, person_id: "e0000001-0000-4000-8000-0000000000a1" }]);
    expect(await rows(db, sql`select id from person where whatsapp_consent_at is not null`)).toEqual([]);
  });

  it("leaves every suppression row where it was: each workspace lists its own", async () => {
    expect(await rows(db, sql`select count(*)::int as count from suppression`)).toEqual([{ count: 5 }]);
    expect((await suppressedOf(db, A1)).map(({ value }) => value).toSorted()).toEqual(["client.example", "stop@acme.example"]);
    expect((await suppressedOf(db, A2)).map(({ value }) => value).toSorted()).toEqual(["asked@acme.example", "dead@acme.example"]);
    expect(await suppressedOf(db, A3)).toEqual([]);
    expect((await suppressedOf(db, B1)).map(({ value }) => value)).toEqual(["dead@fabrikam.example"]);
    expect(await suppressedOf(db, C1)).toEqual([]);
  });

  it("lets sending read a bounce across the group, and nothing else across it", async () => {
    const seenFrom = (id: string) => withWorkspace(db, id, suppressedIn);
    expect([...(await seenFrom(A1)).bouncedElsewhere]).toEqual(["dead@acme.example"]);
    expect([...(await seenFrom(A3)).bouncedElsewhere]).toEqual(["dead@acme.example"]);
    expect((await seenFrom(A3)).refused.size).toBe(0);
    expect((await seenFrom(B1)).bouncedElsewhere.size).toBe(0);
  });
});

describe("contact details", () => {
  const JEANNE = "e0000001-0000-4000-8000-0000000000a1";

  it("that were published are shared with the directory, once, with the oldest page", async () => {
    expect(await contactsOf(db, A1, [JEANNE])).toEqual([{ personId: JEANNE, kind: "email", value: "jeanne@acme.example", page: "https://acme.example/contact", source: "website" }]);
    expect(await contactsOf(db, A3, [JEANNE])).toEqual(await contactsOf(db, A1, [JEANNE]));
  });

  it("from a workspace's own file stay its own, and read once where it also holds what's published", async () => {
    const seen = await contactsOf(db, A2, [JEANNE]);
    expect(seen.map(({ value, page }) => [value, page]).toSorted()).toEqual([["+33612345678", null], ["jeanne@acme.example", "https://acme.example/contact"]]);
  });

  it("don't reach another owner", async () => {
    expect(await contactsOf(db, B1, [JEANNE])).toEqual([]);
    expect(await contactsOf(db, A1, ["e0000003-0000-4000-8000-0000000000b1"])).toEqual([]);
  });
});

describe("the code already running when this migration lands", () => {
  /** What it sends to add a company: it knows nothing of directories. */
  const oldUpsert = (siren: string) => sql`
    insert into company (siren, name, source) values (${siren}, 'FROM OLD CODE', 'registry')
    on conflict (workspace_id, siren) do update set name = excluded.name, updated_at = now() returning id`;

  it("still adds a company another workspace of the directory already holds, and gets its row", async () => {
    const [row] = await withWorkspace(db, A3, (tx) => rows(tx, oldUpsert("900000004")));
    expect(row.id).toBe("c0000004-0000-4000-8000-0000000000a2");
    expect(await rows(db, sql`select count(*)::int as count from company where siren = '900000004'`)).toEqual([{ count: 1 }]);
  });

  it("still adds a company nobody has, and it lands in the directory", async () => {
    const [row] = await withWorkspace(db, A3, (tx) => rows(tx, oldUpsert("900000077")));
    expect(await rows(db, sql`select workspace_id, directory_id = (select directory_id from workspace where id = ${A3}) as ours from company where id = ${row.id as string}`)).toEqual([{ workspace_id: A3, ours: true }]);
  });

  it("still adds a company with another owner's SIREN, which stays another row", async () => {
    const [row] = await withWorkspace(db, C1, (tx) => rows(tx, oldUpsert("900000002")));
    expect(["c0000002-0000-4000-8000-0000000000a1", "c0000002-0000-4000-8000-0000000000b1"]).not.toContain(row.id);
  });

  it("still starts a workspace, in a new group named after it", async () => {
    const [{ directory_id }] = await rows(db, sql`insert into workspace (name, slug) values ('From old code', 'old-code-1') returning directory_id`);
    expect(await rows(db, sql`select name from directory where id = ${directory_id as string}`)).toEqual([{ name: "From old code" }]);
  });

  it("still suppresses and reads as it did", async () => {
    await withWorkspace(db, A3, (tx) => rows(tx, sql`insert into suppression (value, reason) values ('old@acme.example', 'opted_out') on conflict do nothing returning id`));
    expect((await suppressedOf(db, A3)).map(({ value }) => value)).toContain("old@acme.example");
    expect((await suppressedOf(db, A1)).map(({ value }) => value)).not.toContain("old@acme.example");
  });
});

describe("the code that uses it, on merged data", () => {
  it("finds the kept person from any workspace of the directory, on its own list", async () => {
    const listId = await createList(db, A3, "Une autre");
    await addFromRegistry(db, A3, listId, [fromRegistry(holding("900000001", { dirigeants: [{ type_dirigeant: "personne physique", nom: "MARTIN", prenoms: "JEANNE", qualite: "Présidente" }] }))]);
    expect(await prospectsOf(db, A3, listId)).toMatchObject([{ personId: "e0000001-0000-4000-8000-0000000000a1" }]);
    expect(await rows(db, sql`select count(*)::int as count from company where siren = '900000001'`)).toEqual([{ count: 1 }]);
  });

  it("starts a founder's next workspace in a new group, or in theirs if they say so", async () => {
    const [{ group }] = await rows(db, sql`select directory_id as group from workspace where id = ${A1}`);
    const alone = await createWorkspace(db, "ada", "Northwind Labs");
    const joined = await createWorkspace(db, "ada", "Northwind Paris", group as string);
    const [found] = await rows(db, sql`select (select directory_id from workspace where id = ${alone}) = ${group as string}::uuid as alone, (select directory_id from workspace where id = ${joined}) = ${group as string}::uuid as joined`);
    expect(found).toEqual({ alone: false, joined: true });
  });

  it("lists the groups an owner may add to, across founders: a co-owner has the one they share", async () => {
    expect((await groupsOwnedBy(db, "cleo")).map(({ name }) => name).toSorted()).toEqual(["Contoso", "Northwind"]);
    expect(await groupsOwnedBy(db, "dan")).toEqual([]);
  });
});

/** Someone with an address in each of two workspaces: the second's own, which they asked it to stop at. */
const ASKED_THE_SECOND_TO_STOP = `
  insert into company(id,workspace_id,siren,name,source,created_at,updated_at) values
    ('c9000001-0000-4000-8000-0000000000a1','${A1}','900000099','RONDE SAS','registry','2026-10-01','2026-10-01'),
    ('c9000001-0000-4000-8000-0000000000a2','${A2}','900000099','RONDE SAS','registry','2026-10-02','2026-10-02');
  insert into person(id,workspace_id,company_id,first_name,last_name,source,created_at) values
    ('e9000001-0000-4000-8000-0000000000a1','${A1}','c9000001-0000-4000-8000-0000000000a1','Rene','Ronde','registry','2026-10-01'),
    ('e9000001-0000-4000-8000-0000000000a2','${A2}','c9000001-0000-4000-8000-0000000000a2','Rene','Ronde','registry','2026-10-02');
  insert into contact_detail(workspace_id,person_id,kind,value,page,source,created_at) values
    ('${A1}','e9000001-0000-4000-8000-0000000000a1','email','contact@ronde.example','https://ronde.example/c','website','2026-10-03'),
    ('${A2}','e9000001-0000-4000-8000-0000000000a2','email','rene@perso.example',NULL,'import','2026-10-04');
  insert into prospect_list(id,workspace_id,name) values ('f9000001-0000-4000-8000-0000000000a1','${A1}','L1'),('f9000001-0000-4000-8000-0000000000a2','${A2}','L2');
  insert into prospect(id,workspace_id,list_id,person_id,state) values
    ('19000001-0000-4000-8000-0000000000a1','${A1}','f9000001-0000-4000-8000-0000000000a1','e9000001-0000-4000-8000-0000000000a1','in_sequence'),
    ('19000001-0000-4000-8000-0000000000a2','${A2}','f9000001-0000-4000-8000-0000000000a2','e9000001-0000-4000-8000-0000000000a2','in_sequence');
  insert into sequence(id,workspace_id,name,status,"window") values
    ('29000001-0000-4000-8000-0000000000a1','${A1}','S1','running','{"days":[1,2,3,4,5],"from":"09:00","to":"17:00","timezone":"Europe/Paris"}'),
    ('29000001-0000-4000-8000-0000000000a2','${A2}','S2','running','{"days":[1,2,3,4,5],"from":"09:00","to":"17:00","timezone":"Europe/Paris"}');
  insert into sequence_step(id,workspace_id,sequence_id,position,channel,body) values
    ('39000001-0000-4000-8000-0000000000a1','${A1}','29000001-0000-4000-8000-0000000000a1',0,'email','Une idée.'),
    ('39000001-0000-4000-8000-0000000000a2','${A2}','29000001-0000-4000-8000-0000000000a2',0,'email','Une autre.');
  insert into enrollment(id,workspace_id,sequence_id,prospect_id,person_id,company_id,status,next_due_at) values
    ('49000001-0000-4000-8000-0000000000a1','${A1}','29000001-0000-4000-8000-0000000000a1','19000001-0000-4000-8000-0000000000a1','e9000001-0000-4000-8000-0000000000a1','c9000001-0000-4000-8000-0000000000a1','active','2026-11-08'),
    ('49000001-0000-4000-8000-0000000000a2','${A2}','29000001-0000-4000-8000-0000000000a2','19000001-0000-4000-8000-0000000000a2','e9000001-0000-4000-8000-0000000000a2','c9000001-0000-4000-8000-0000000000a2','active','2026-11-08');
  insert into step_message(id,workspace_id,enrollment_id,step_id,channel,body,status) values
    ('59000001-0000-4000-8000-0000000000a1','${A1}','49000001-0000-4000-8000-0000000000a1','39000001-0000-4000-8000-0000000000a1','email','Prêt.','draft'),
    ('59000001-0000-4000-8000-0000000000a2','${A2}','49000001-0000-4000-8000-0000000000a2','39000001-0000-4000-8000-0000000000a2','email','Prêt.','draft');
  insert into suppression(workspace_id,value,reason) values ('${A2}','rene@perso.example','asked');
`;

describe("spec, section 8: an opt-out stops that person's sequences in the workspace it was said to", () => {
  let stopping: Database;
  let answer: Record<string, unknown>;

  beforeAll(async () => {
    const before = await databaseBeforeDirectory();
    stopping = before.db;
    for (const statement of ASKED_THE_SECOND_TO_STOP.split(";\n").filter((text) => text.trim())) await stopping.execute(sql.raw(statement));
    [answer] = await rows(stopping, PREVIEW);
    await before.finishMigrating();
  }, 120_000);

  const enrollmentIn = (id: string) => rows(stopping, sql`select status, stop_reason from enrollment where id = ${id}`);
  const messageIn = (id: string) => rows(stopping, sql`select status from step_message where id = ${id}`);

  it("whichever address the merge left first: that workspace's sequence stops, and what it had scheduled", async () => {
    expect(await enrollmentIn("49000001-0000-4000-8000-0000000000a2")).toEqual([{ status: "stopped", stop_reason: "suppressed" }]);
    expect(await messageIn("59000001-0000-4000-8000-0000000000a2")).toEqual([{ status: "skipped" }]);
  });

  it("and no other workspace's: a group shares the person, not the opt-out", async () => {
    expect(await enrollmentIn("49000001-0000-4000-8000-0000000000a1")).toEqual([{ status: "active", stop_reason: null }]);
    expect(await messageIn("59000001-0000-4000-8000-0000000000a1")).toEqual([{ status: "draft" }]);
  });

  it("and the preview counted it, before anything ran", () => {
    expect(Number(answer.running_enrollments_stopped_for_a_suppressed_detail)).toBe(1);
  });
});
