import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { requestJson } from "../http";
import { checkAccount, type CrmCompany, type CrmRecords, fullName, holds, including, jsonHeaders, jsonInit, known, onSubdomain, pushThrough } from "./push";

/**
 * Pipedrive, on the account's own subdomain: API v2 for persons and organizations (v1's left
 * support on 2026-08-01) and v1 for notes (v2 has none).
 *
 * Docs: https://pipedrive.readme.io/docs/core-api-concepts-authentication
 *       https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml (persons, organizations)
 *       https://developers.pipedrive.com/docs/api/v1/openapi.yaml (users/me, notes)
 *       https://developers.pipedrive.com/changelog/post/deprecated-apiv1-endpoints-become-out-of-support
 *
 * An organization can only be searched by name: its website isn't searchable and it has no SIREN.
 * A person's job title is left out: writing it answers 403 unless the account syncs its contacts.
 */

const PROVIDER = "Pipedrive";

interface FoundPerson {
  id: number;
  emails?: string[];
  phones?: string[];
}

type Search<T> = { data: { items: { item: T }[] } };

/** Pipedrive reads a note's content as HTML. */
const asHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const values = (list: string[]) => list.map((value) => ({ value }));

/** The person's fields; addresses and numbers only when one is new, since a write replaces the whole list. */
function personFields(contact: CrmContact, companyId: string, found: FoundPerson | null) {
  const emails = including(found?.emails, contact.email);
  const phones = including(found?.phones, contact.phone);
  return {
    name: fullName(contact),
    org_id: Number(companyId),
    ...(contact.email && !holds(found?.emails, contact.email) ? { emails: values(emails) } : {}),
    ...(contact.phone && !holds(found?.phones, contact.phone) ? { phones: values(phones) } : {}),
  };
}

const call = <T>(context: AdapterContext, path: string, method = "GET", body?: unknown) =>
  requestJson<T>(context.fetch, PROVIDER, `${onSubdomain(PROVIDER, context.fields.companyDomain, "pipedrive.com")}${path}`, jsonInit(method, jsonHeaders({ "x-api-token": context.fields.apiToken }), body));

function pipedriveRecords(context: AdapterContext): CrmRecords<number, FoundPerson> {
  /** The first exact match, not case sensitive. */
  async function search<T>(resource: string, term: string, field: string, also = ""): Promise<T | null> {
    const { data } = await call<Search<T>>(context, `/api/v2/${resource}/search?term=${encodeURIComponent(term)}&fields=${field}&exact_match=true&limit=1${also}`);
    return data.items[0]?.item ?? null;
  }

  return {
    async findCompany(company: CrmCompany) {
      return (await search<{ id: number }>("organizations", company.name, "name"))?.id ?? null;
    },

    async saveCompany(company, found) {
      if (found === null) return String((await call<{ data: { id: number } }>(context, "/api/v2/organizations", "POST", known({ name: company.name, website: company.website }))).data.id);
      if (company.website) await call(context, `/api/v2/organizations/${found}`, "PATCH", { website: company.website });
      return String(found);
    },

    findPerson(contact, companyId) {
      if (contact.email) return search<FoundPerson>("persons", contact.email, "email");
      return search<FoundPerson>("persons", fullName(contact), "name", `&organization_id=${companyId}`);
    },

    async savePerson(contact, companyId, found) {
      if (!found) return String((await call<{ data: { id: number } }>(context, "/api/v2/persons", "POST", personFields(contact, companyId, null))).data.id);
      await call(context, `/api/v2/persons/${found.id}`, "PATCH", personFields(contact, companyId, found));
      return String(found.id);
    },

    async addNote(contact, personId) {
      await call(context, "/api/v1/notes", "POST", { content: asHtml(contact.note), person_id: Number(personId) });
    },
  };
}

export const pipedrive: Adapter = (context) => ({
  check: () => checkAccount(async () => (await call<{ data: { company_name: string } }>(context, "/api/v1/users/me")).data.company_name),
  pushContact: (contact) => pushThrough(pipedriveRecords(context), contact),
});
