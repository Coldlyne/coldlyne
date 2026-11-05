import { beforeAll, describe, expect, it, vi } from "vitest";
import { confirmContact, contactsOf, pushesOf, pushToCrm } from "@/application/contacts";
import { connectWithFields } from "@/application/connections";
import { importProspects, importSheet } from "@/application/imports";
import { addFromRegistry, createList, prospectsOf, suppress } from "@/application/prospects";
import type { Services } from "@/application/services";
import { readProspectsCsv, readProspectsSheet } from "@/domain/csv-import";
import { fromRegistry } from "@/domain/registry";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const pushContact = vi.fn();
const sheet: { rows?: ReturnType<typeof vi.fn> } = {};
vi.mock("@/infrastructure/connectors", () => ({ adapterOf: () => () => ({ check: async () => ({ ok: true, detail: "ok", label: "CRM" }), pushContact, ...sheet }) }));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const REGISTRY = "GET https://recherche-entreprises.api.gouv.fr/search";
const registry = (...companies: ReturnType<typeof holding>[]) => ({ match: REGISTRY, json: { results: companies, total_results: companies.length, page: 1, total_pages: 1 } });

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([registry()]).fetch, now: () => new Date("2026-11-04T09:00:00Z") };
});

async function list() {
  const seat = await createTestWorkspace(db);
  return { ...seat, listId: await createList(db, seat.workspaceId, "Fichier") };
}

const csv = (...rows: string[]) => readProspectsCsv(["prenom;nom;email;telephone;societe;siren", ...rows].join("\n"));

describe("importing a member's file", () => {
  it("puts people on the list with their company and how to reach them", async () => {
    const { workspaceId, listId } = await list();
    const result = await importProspects(services, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;06 12 34 56 78;Acme;"));
    expect(result).toEqual({ added: 1, rejected: [] });
    const [found] = await prospectsOf(db, workspaceId, listId);
    expect(found).toMatchObject({ firstName: "Ada", lastName: "Lovelace", company: "Acme", state: "new" });
    expect(await contactsOf(db, workspaceId, [found.personId])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "email", value: "ada@acme.fr", source: "import", page: null }), expect.objectContaining({ kind: "phone", value: "+33612345678" })]));
  });

  it("adds no one twice, and reuses a company known by name", async () => {
    const { workspaceId, listId } = await list();
    await importProspects(services, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;;Acme;", "Bob;Martin;bob@acme.fr;;Acme;"));
    const again = await importProspects(services, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;;Acme;"));
    expect(again.added).toBe(0);
    expect(await prospectsOf(db, workspaceId, listId)).toHaveLength(2);
  });

  it("leaves out a company that refused commercial use or closed, even in the member's own file", async () => {
    const { workspaceId, listId } = await list();
    const refusing = { ...services, fetch: fakeFetch([registry(holding("732829320", { opposition_diffusion_commerciale: true }))]).fetch };
    const result = await importProspects(refusing, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;;Acme;732829320"));
    expect(result.added).toBe(0);
    expect(result.rejected).toEqual([{ line: 2, why: "l’entreprise est fermée ou a refusé l’usage commercial de ses données" }]);
  });

  it("leaves out someone suppressed, by address, by domain or by number", async () => {
    const { workspaceId, listId } = await list();
    await suppress(db, workspaceId, "ada@acme.fr");
    await suppress(db, workspaceId, "gone.fr");
    await suppress(db, workspaceId, "+33612345678");
    const result = await importProspects(services, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;;Acme;", "Bob;Martin;bob@gone.fr;;Gone;", "Carl;Duval;;06 12 34 56 78;Acme;", "Dora;Petit;dora@acme.fr;;Acme;"));
    expect(result.added).toBe(1);
    expect(result.rejected.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(result.rejected[0].why).toContain("liste d’exclusion");
  });

  it("says what's missing, and keeps the file's unreadable rows with their line", async () => {
    const { workspaceId, listId } = await list();
    const result = await importProspects(services, workspaceId, listId, csv(";;ada@acme.fr;;Acme;", "Bob;Martin;bob@acme.fr;;;", "Carl;Duval;not-an-email;;Acme;"));
    expect(result.added).toBe(0);
    expect(result.rejected.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(result.rejected[0].why).toContain("nom");
    expect(result.rejected[1].why).toContain("entreprise");
  });

  it("asks the registry first, so a refused lookup leaves nothing half imported, and refuses a file too large to check", async () => {
    const { workspaceId, listId } = await list();
    const down = { ...services, fetch: fakeFetch([{ match: REGISTRY, status: 429, json: {} }]).fetch };
    await expect(importProspects(down, workspaceId, listId, csv("Ada;Lovelace;ada@acme.fr;;Acme;732829320"))).rejects.toThrow(/limite le nombre de demandes/);
    expect(await prospectsOf(db, workspaceId, listId)).toEqual([]);

    const rows = Array.from({ length: 201 }, (_, index) => ({ line: index + 2, firstName: "A", lastName: `B${index}`, email: null, phone: null, company: "Acme", siren: String(index).padStart(9, "0"), siret: null, website: null, role: null, linkedin: null }));
    await expect(importProspects(services, workspaceId, listId, { rows, rejected: [], columns: [] })).rejects.toThrow(/par tranches/);
  });

  it("reads a spreadsheet's rows the same way", async () => {
    const { workspaceId, listId } = await list();
    const sheet = readProspectsSheet([{ Prénom: "Ada", Nom: "Lovelace", Email: "ADA@acme.fr", Société: "Acme" }, { Prénom: "Bob", Nom: "", Email: "nope", Société: "Acme" }]);
    expect(sheet.rows).toMatchObject([{ line: 2, firstName: "Ada", email: "ada@acme.fr" }]);
    expect(sheet.rejected.map((row) => row.line)).toEqual([3]);
    expect((await importProspects(services, workspaceId, listId, sheet)).added).toBe(1);
    expect(readProspectsSheet([])).toEqual({ rows: [], rejected: [], columns: [] });
  });
});

describe("contact details", () => {
  it("keeps what a member confirmed, with its page, only for a prospect of this workspace", async () => {
    const { workspaceId, listId } = await list();
    await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
    const [found] = await prospectsOf(db, workspaceId, listId);
    const finding = { kind: "email" as const, value: "contact@acme.fr", page: "https://acme.fr/contact" };
    expect(await confirmContact(db, workspaceId, found.id, finding)).toBe(true);
    expect(await confirmContact(db, workspaceId, found.id, finding)).toBe(true);
    expect(await contactsOf(db, workspaceId, [found.personId])).toMatchObject([{ kind: "email", value: "contact@acme.fr", page: "https://acme.fr/contact", source: "website" }]);
    expect(await contactsOf(db, workspaceId, [])).toEqual([]);

    const other = await createTestWorkspace(db, "Other");
    expect(await confirmContact(db, other.workspaceId, found.id, finding)).toBe(false);
    expect(await contactsOf(db, other.workspaceId, [found.personId])).toEqual([]);
  });
});

describe("sending a prospect to the CRM", () => {
  it("sends who they are, how to reach them and the note", async () => {
    const { workspaceId, listId, userId } = await list();
    await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
    const [found] = await prospectsOf(db, workspaceId, listId);
    await confirmContact(db, workspaceId, found.id, { kind: "email", value: "jeanne@acme.fr", page: "https://acme.fr" });
    const connected = await connectWithFields(services, workspaceId, userId, "hubspot", { accessToken: "t" });
    if (!connected.ok) throw new Error(connected.error);
    pushContact.mockResolvedValue({ externalId: "crm-1" });

    expect(await pushToCrm(services, workspaceId, connected.connection.id, found.id, "A répondu : intéressée")).toMatchObject({ ok: true, externalId: "crm-1", already: false });
    expect(pushContact).toHaveBeenCalledWith({ firstName: "Jeanne", lastName: "Dupont-Martin", email: "jeanne@acme.fr", phone: null, role: "Président de SAS", company: { name: "ACME HOLDING", siren: "900000001", website: null }, note: "A répondu : intéressée" });

    expect((await pushToCrm(services, workspaceId, connected.connection.id, crypto.randomUUID(), "x")).ok).toBe(false);
    expect((await pushToCrm(services, workspaceId, crypto.randomUUID(), found.id, "x")).ok).toBe(false);
  });

  async function pushable() {
    const { workspaceId, listId, userId } = await list();
    await addFromRegistry(db, workspaceId, listId, [fromRegistry(holding())]);
    const [found] = await prospectsOf(db, workspaceId, listId);
    const connected = await connectWithFields(services, workspaceId, userId, "hubspot", { accessToken: "t" });
    if (!connected.ok) throw new Error(connected.error);
    pushContact.mockReset();
    pushContact.mockResolvedValue({ externalId: "crm-1" });
    return { workspaceId, prospectId: found.id, connectionId: connected.connection.id };
  }

  it("doesn't add the same note twice when an assistant tries again", async () => {
    const { workspaceId, prospectId, connectionId } = await pushable();
    await pushToCrm(services, workspaceId, connectionId, prospectId, "A répondu");
    expect(await pushToCrm(services, workspaceId, connectionId, prospectId, "A répondu")).toMatchObject({ ok: true, externalId: "crm-1", already: true });
    expect(pushContact).toHaveBeenCalledTimes(1);
    await pushToCrm(services, workspaceId, connectionId, prospectId, "A pris rendez-vous");
    expect(pushContact).toHaveBeenCalledTimes(2);
  });

  it("brings the person up to date as often as asked when there's no note, and shows when", async () => {
    const { workspaceId, prospectId, connectionId } = await pushable();
    expect(await pushesOf(db, workspaceId, [prospectId])).toEqual([]);
    await pushToCrm(services, workspaceId, connectionId, prospectId, "");
    await pushToCrm(services, workspaceId, connectionId, prospectId, "");
    expect(pushContact).toHaveBeenCalledTimes(2);
    expect(pushContact.mock.calls[0][0]).toMatchObject({ note: "" });
    expect(await pushesOf(db, workspaceId, [prospectId])).toEqual([{ prospectId, connectionId, pushedAt: new Date("2026-11-04T09:00:00Z") }]);
    expect(await pushesOf(db, workspaceId, [])).toEqual([]);
  });

  it("says why when the CRM refuses, and remembers nothing", async () => {
    const { workspaceId, prospectId, connectionId } = await pushable();
    pushContact.mockRejectedValue(new Error("Jeton révoqué"));
    expect(await pushToCrm(services, workspaceId, connectionId, prospectId, "A répondu")).toEqual({ ok: false, error: "Jeton révoqué" });
    expect(await pushesOf(db, workspaceId, [prospectId])).toEqual([]);
  });

  it("keeps each workspace's pushes to itself", async () => {
    const { workspaceId, prospectId, connectionId } = await pushable();
    await pushToCrm(services, workspaceId, connectionId, prospectId, "");
    const other = await list();
    expect(await pushesOf(db, other.workspaceId, [prospectId])).toEqual([]);
  });
});

describe("importing a sheet", () => {
  it("reads it through the connection, by its id or its address", async () => {
    const { workspaceId, listId, userId } = await list();
    const connected = await connectWithFields(services, workspaceId, userId, "hubspot", { accessToken: "t" });
    if (!connected.ok) throw new Error(connected.error);
    expect(await importSheet(services, workspaceId, connected.connection.id, listId, "abc")).toEqual({ ok: false, error: "Cette connexion ne lit pas de feuille de calcul." });
    sheet.rows = vi.fn().mockResolvedValue([{ prénom: "Ada", nom: "Martin", email: "ada@acme.fr", entreprise: "Acme" }]);
    const imported = await importSheet(services, workspaceId, connected.connection.id, listId, "https://docs.google.com/spreadsheets/d/1aB-c_D/edit#gid=0", "A1:D9");
    expect(imported).toMatchObject({ ok: true, imported: { added: 1 } });
    expect(sheet.rows).toHaveBeenCalledWith("1aB-c_D", "A1:D9");
    sheet.rows = vi.fn().mockRejectedValue(new Error("Feuille introuvable"));
    expect(await importSheet(services, workspaceId, connected.connection.id, listId, "abc")).toEqual({ ok: false, error: "Feuille introuvable" });
    delete sheet.rows;
  });
});
