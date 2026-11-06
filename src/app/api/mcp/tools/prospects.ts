import { z } from "zod";
import { contactsOf } from "@/application/contacts";
import { elsewhereOf, rememberCompanies, searchDirectory } from "@/application/directory";
import { addCompanies, createList, listsOf, prospectsOf, suppress, suppressedOf } from "@/application/prospects";
import { prospectable, type RegistryCompany } from "@/domain/registry";
import { searchRegistry } from "@/infrastructure/registry/client";
import { answer, type ToolRegistrar } from "./tool";

/** What a search returns about a company: enough to choose, without directors' private details. */
const brief = (found: RegistryCompany) => ({
  siren: found.siren,
  name: found.name,
  legalForm: found.legalForm,
  activity: found.activity,
  postcode: found.postcode,
  city: found.city,
  createdOn: found.createdOn,
  mayBeProspected: prospectable(found),
  directors: found.directors.filter((director) => director.kind === "person").map(({ firstName, lastName, role }) => ({ firstName, lastName, role })),
});

/** Finding companies in the French registry, and keeping lists of the people to reach. */
export const prospectTools: ToolRegistrar = (server, context) => {
  const { services, workspaceId } = context;

  server.registerTool(
    "search_group",
    {
      title: "Search what this workspace's group already knows",
      description:
        "Companies this workspace's group already holds, by SIREN or name, with their people, how to reach them (each with the page it was found on), and whether another workspace of the group wrote to them or they opted out of it. Ask here before search_registry and find_contacts: what another workspace of the group found needs no new lookup. It shows what's there about a company you're looking for, not a list of everything, and being here doesn't put anyone on this workspace's lists.",
      inputSchema: z.object({ words: z.string().min(2).describe("A SIREN, or words from the company's name.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ words }) => answer({ companies: await searchDirectory(services.db, workspaceId, words) }),
  );

  server.registerTool(
    "search_registry",
    {
      title: "Search the French company registry",
      description:
        "Active French companies by activity code (NAF, e.g. 64.20Z for holdings), legal form (5710 SAS, 5499 SARL; the registry refuses 5720 and 5498, so SASU and EURL can't be asked for apart), department, postcode, headcount band or words, with their directors. 25 a page. Companies that refused commercial use of their data are marked and can't be added. What it finds is kept for the workspaces of this group, without being put on any list.",
      inputSchema: z.object({
        activities: z.array(z.string()).optional(),
        legalForms: z.array(z.string()).optional(),
        department: z.string().optional(),
        postcode: z.string().optional(),
        sizes: z.array(z.string()).optional().describe("INSEE's headcount bands: NN, 00, 01 (1–2), 02 (3–5), 03 (6–9), 11 (10–19), 12 (20–49)…"),
        words: z.string().optional(),
        page: z.number().int().min(1).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (query) => {
      const page = await searchRegistry(query, services.fetch);
      await rememberCompanies(services.db, workspaceId, page.companies);
      return answer({ total: page.total, page: page.page, pages: page.pages, companies: page.companies.map(brief) });
    },
  );

  server.registerTool(
    "create_list",
    { title: "Create a prospect list", description: "A new list of prospects a campaign will work through.", inputSchema: z.object({ name: z.string().min(1) }) },
    async ({ name }) => answer({ listId: await createList(services.db, workspaceId, name), name }),
  );

  server.registerTool(
    "list_lists",
    { title: "The workspace's lists", description: "The workspace's prospect lists, with how many prospects each holds.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => answer({ lists: await listsOf(services.db, workspaceId) }),
  );

  server.registerTool(
    "add_companies_to_list",
    {
      title: "Add companies' directors to a list",
      description: "Puts the directors (people, not companies) of these companies on a list, by SIREN. Companies that refused commercial use of their data, or closed, are left out and said so; no one is added twice. What the group holds needs no new lookup. `elsewhere` names anyone added whom another workspace of the group wrote to or who opted out of it, with when: tell the member, who decides. It stops nobody.",
      inputSchema: z.object({ listId: z.uuid(), sirens: z.array(z.string().regex(/^\d{9}$/)).min(1).max(100) }),
    },
    async ({ listId, sirens }) => answer({ ...(await addCompanies(services, workspaceId, listId, sirens)) }),
  );

  server.registerTool(
    "list_prospects",
    { title: "A list's prospects", description: "The people on a list, with their company and where they are with it, and `elsewhere` when another workspace of the group wrote to them or they opted out of it, with when: tell the member before writing, who decides.", inputSchema: z.object({ listId: z.uuid() }), annotations: { readOnlyHint: true } },
    async ({ listId }) => {
      const prospects = await prospectsOf(services.db, workspaceId, listId);
      const people = prospects.map((found) => found.personId);
      const [contacts, elsewhere] = [await contactsOf(services.db, workspaceId, people), await elsewhereOf(services.db, workspaceId, people)];
      const notesOn = (personId: string) => {
        const notes = elsewhere.filter((note) => note.personId === personId).map(({ workspace, writtenAt, optedOutAt }) => ({ workspace, writtenAt, optedOutAt }));
        return notes.length ? { elsewhere: notes } : {};
      };
      return answer({ prospects: prospects.map((found) => ({ ...found, contacts: contacts.filter((contact) => contact.personId === found.personId).map(({ kind, value, page, source }) => ({ kind, value, page, source })), ...notesOn(found.personId) })) });
    },
  );

  server.registerTool(
    "suppress",
    {
      title: "Never write to someone again",
      description: "Puts an email address, a phone number or a whole domain on this workspace's suppression list, for every channel and every mailbox or domain it writes from, now or later. Use it as soon as someone asks not to be contacted: their sequences here stop at once. It stays this workspace's: the others of its group are told, and decide. With asked false, it's this workspace's own exclusion (\"this domain is my client\"), which nobody else hears of.",
      inputSchema: z.object({ value: z.string().min(3).describe("ada@acme.fr, +33612345678, or acme.fr"), asked: z.boolean().default(true).describe("Whether the person asked for it.") }),
    },
    async ({ value, asked }) => {
      await suppress(services.db, workspaceId, value, asked ? "asked" : "member");
      return answer({ suppressed: value.trim().toLowerCase() });
    },
  );

  server.registerTool(
    "list_suppressed",
    { title: "Suppression list", description: "Who this workspace never writes to again, and why.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => answer({ suppressed: await suppressedOf(services.db, workspaceId) }),
  );
};
