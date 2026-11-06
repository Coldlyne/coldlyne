import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addCompanyAction, findCompaniesAction, importCsvAction } from "@/app/lists/actions";
import { enrollListAction } from "@/app/sequences/actions";
import { confirmContact } from "@/application/contacts";
import { addFromRegistry, createList, prospectsOf } from "@/application/prospects";
import { createSequence } from "@/application/sequences";
import type { Services } from "@/application/services";
import { createWorkspace } from "@/application/workspaces";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import { outreach } from "@/infrastructure/db/schema/connections";
import { person } from "@/infrastructure/db/schema/prospects";
import { enrollment, sequence } from "@/infrastructure/db/schema/sequences";
import { workspace } from "@/infrastructure/db/schema/tenancy";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { expectFrenchTypography } from "./support/french";
import { holding } from "./support/registry";

const screen = vi.hoisted(() => ({ workspaceId: "", services: undefined as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/infrastructure/auth/session", () => ({ currentSeat: async () => ({ workspaceId: screen.workspaceId, userId: "ada" }) }));
vi.mock("@/infrastructure/services", () => ({ appServices: () => screen.services }));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const WRITTEN_ON = new Date("2026-11-03T10:00:00Z");

let db: Database;
let services: Services;

beforeAll(async () => {
  db = await createTestDatabase();
});
beforeEach(() => {
  // Nothing but this fake answers: a screen that goes out for what the directory holds fails here.
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => new Date("2026-11-06T09:00:00Z") };
  screen.services = services;
});

/** Two businesses of one owner; the first wrote to Jeanne, and published her address. The browser is in the second. */
async function inSecondAfterFirstWrote() {
  const { workspaceId: first, userId } = await createTestWorkspace(db, "Northwind");
  const [{ group }] = await db.select({ group: workspace.directoryId }).from(workspace).where(eq(workspace.id, first));
  const second = await createWorkspace(db, userId, "Contoso", group);
  const list = await createList(db, first, "Holdings");
  await addFromRegistry(db, first, list, [fromRegistry(holding())]);
  const [jeanne] = await prospectsOf(db, first, list);
  await confirmContact(db, first, jeanne.id, { kind: "email", value: "jeanne@acme.example", page: "https://acme.example/contact" });
  await withWorkspace(db, first, async (tx) => {
    const [{ companyId }] = await tx.select({ companyId: person.companyId }).from(person).where(eq(person.id, jeanne.personId));
    const [campaign] = await tx.insert(sequence).values({ name: "Campagne", window: { days: [1], from: "09:00", to: "17:00", timezone: "Europe/Paris" } }).returning({ id: sequence.id });
    const [enrolled] = await tx.insert(enrollment).values({ sequenceId: campaign.id, prospectId: jeanne.id, personId: jeanne.personId, companyId }).returning({ id: enrollment.id });
    await tx.insert(outreach).values({ channel: "email", address: "jeanne@acme.example", enrollmentId: enrolled.id, sentAt: WRITTEN_ON });
  });
  screen.workspaceId = second;
  return { first, second, userId, listId: await createList(db, second, "Leur liste") };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const NOTE = "Jeanne Dupont-Martin : a été contactée depuis Northwind le 3 novembre 2026.";

describe("a member at a list's page", () => {
  it("finds what another workspace found, asking nobody, with its address and who wrote", async () => {
    await inSecondAfterFirstWrote();
    const { found } = await findCompaniesAction({}, form({ words: "ACME" }));
    expect(found).toMatchObject({ from: "directory", companies: [{ siren: "900000001", held: true, people: [{ firstName: "Jeanne", contacts: [{ value: "jeanne@acme.example" }], elsewhere: [{ workspace: "Northwind" }] }] }] });
  });

  it("asks the registry only when they say so, or when the directory holds nothing", async () => {
    await inSecondAfterFirstWrote();
    const fake = fakeFetch([{ match: "GET https://recherche-entreprises.api.gouv.fr/search", json: { results: [holding("900000002", { nom_complet: "ACME CONSEIL" })], total_results: 1, page: 1, total_pages: 1 } }]);
    screen.services = { ...services, fetch: fake.fetch };
    expect((await findCompaniesAction({}, form({ words: "ACME", registry: "1" }))).found).toMatchObject({ from: "registry", companies: [{ siren: "900000002", held: false }] });
    expect(fake.calls).toHaveLength(1);
    expect((await findCompaniesAction({}, form({ words: "Inconnue" }))).found?.from).toBe("registry");
    expect(fake.calls).toHaveLength(2);
  });

  it("says plainly what's wrong with a search, and when the registry is down", async () => {
    expect(await findCompaniesAction({}, form({ words: " " }))).toEqual({ error: "Indiquez un nom ou un SIREN." });
    await inSecondAfterFirstWrote();
    const said = await findCompaniesAction({}, form({ words: "Inconnue" }));
    expect(said).toMatchObject({ words: "Inconnue", error: expect.any(String) });
  });

  it("adds a company, and is told who already wrote and when, without being stopped", async () => {
    const { listId } = await inSecondAfterFirstWrote();
    expect(await addCompanyAction(listId, "900000001")).toEqual({ ok: true, said: `1 personne ajoutée. ${NOTE}` });
    expect(await addCompanyAction(listId, "900000001")).toEqual({ ok: true, said: "Personne de nouveau à ajouter." });
    expect(NOTE).toContain("3 novembre");
    expectFrenchTypography(NOTE);
  });

  it("is told the same when a file adds them", async () => {
    const { listId } = await inSecondAfterFirstWrote();
    const file = form({});
    file.set("file", new File(["prénom,nom,société,siren\nJeanne,Dupont-Martin,ACME HOLDING,900000001\n"], "fichier.csv", { type: "text/csv" }));
    expect((await importCsvAction(listId, {}, file)).result).toMatchObject({ added: 1, elsewhere: [{ person: "Jeanne Dupont-Martin", workspace: "Northwind", writtenAt: WRITTEN_ON }] });
  });
});

describe("a member at a sequence's page", () => {
  it("is told who another workspace already wrote to when adding a list, and adds them", async () => {
    const { second, userId, listId } = await inSecondAfterFirstWrote();
    await addCompanyAction(listId, "900000001");
    const created = await createSequence(services, second, userId, { name: "Leur campagne", steps: [] });
    if (!created.ok) throw new Error(created.error);
    expect(await enrollListAction(created.id, null, form({ listId }))).toEqual({ ok: true, said: `1 personne ajoutée.\n${NOTE}` });
  });
});
