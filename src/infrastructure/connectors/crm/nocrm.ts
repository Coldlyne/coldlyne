import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { requestJson } from "../http";
import { checkAccount, jsonHeaders, jsonInit, known, onSubdomain, sameText } from "./push";

/**
 * noCRM.io: one lead holds the person and the company, its title the company's name and its
 * description the person, in the "Label: value" lines noCRM's API examples use.
 *
 * Docs: https://www.nocrm.io/api
 *       https://help.nocrm.io/en/articles/40-direct-integrations-with-api
 *
 * No endpoint gives the account's name, so the connection is named after its subdomain. A lead
 * made with an API key and no user stays unassigned, and leads can only be searched by email, so
 * without an address the latest leads are compared here (at most a page: the API allows 2,000 calls
 * a day), and an older one won't be found. A member's own text in a description is never replaced.
 */

const PROVIDER = "noCRM.io";
/** The most leads compared by name, when there's no address to search by. */
const LATEST_LEADS = 100;

interface Lead {
  id: number;
  title?: string;
  description?: string | null;
  text_description?: string | null;
}

const call = <T>(context: AdapterContext, path: string, method = "GET", body?: unknown) =>
  requestJson<T>(context.fetch, PROVIDER, `${onSubdomain(PROVIDER, context.fields.subdomain, "nocrm.io")}/api/v2${path}`, jsonInit(method, jsonHeaders({ "x-api-key": context.fields.apiKey }), body));

/** Depending on the lead, noCRM's list gives its text under one name or the other. */
const textOf = (lead: Lead) => lead.description ?? lead.text_description ?? "";

const mentions = (lead: Lead, value: string) => textOf(lead).toLowerCase().includes(value.toLowerCase());

/** The person and the company's details, as a lead's description lines. */
function descriptionLines({ firstName, lastName, email, phone, role, company }: CrmContact): string[] {
  const fields = known({ Firstname: firstName, Lastname: lastName, Email: email, Phone: phone, "Job title": role, Website: company.website, SIREN: company.siren });
  return Object.entries(fields).map(([label, value]) => `${label}: ${value}`);
}

/** The lines with a value this lead doesn't mention yet. */
const newLines = (lead: Lead, lines: string[]) => lines.filter((line) => !mentions(lead, line.slice(line.indexOf(": ") + 2)));

/** A comment naming the address also matches, so a lead whose description names it comes first. */
async function findLead(context: AdapterContext, contact: CrmContact): Promise<Lead | null> {
  if (contact.email) {
    const leads = await call<Lead[]>(context, `/leads?email=${encodeURIComponent(contact.email)}&include_unassigned=true`);
    return leads.find((lead) => mentions(lead, contact.email ?? "")) ?? leads[0] ?? null;
  }
  const leads = await call<Lead[]>(context, `/leads?include_unassigned=true&limit=${LATEST_LEADS}`);
  return leads.find((lead) => sameText(lead.title, contact.company.name) && mentions(lead, contact.lastName) && mentions(lead, contact.firstName ?? "")) ?? null;
}

/** Creates the lead, or adds what its description lacks. */
async function saveLead(context: AdapterContext, contact: CrmContact, found: Lead | null): Promise<number> {
  const lines = descriptionLines(contact);
  if (!found) return (await call<Lead>(context, "/leads", "POST", { title: contact.company.name, description: lines.join("\n") })).id;
  const missing = newLines(found, lines);
  if (missing.length) await call(context, `/leads/${found.id}`, "PUT", { description: [textOf(found), ...missing].filter(Boolean).join("\n") });
  return found.id;
}

async function pushContact(context: AdapterContext, contact: CrmContact): Promise<{ externalId: string }> {
  const id = await saveLead(context, contact, await findLead(context, contact));
  await call(context, `/leads/${id}/comments`, "POST", { content: contact.note });
  return { externalId: String(id) };
}

export const nocrm: Adapter = (context) => ({
  check: () =>
    checkAccount(async () => {
      await call(context, "/ping");
      return context.fields.subdomain;
    }),
  pushContact: (contact) => pushContact(context, contact),
});
