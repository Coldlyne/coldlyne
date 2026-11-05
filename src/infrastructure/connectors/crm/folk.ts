import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { bearerJson, requestJson } from "../http";
import { checkAccount, type CrmCompany, type CrmRecords, domainOf, fullName, holds, including, jsonInit, known, pushThrough } from "./push";

/**
 * folk, through its public API: people, companies and notes.
 *
 * Docs: https://developer.folk.app/api-reference/overview
 *       https://developer.folk.app/api-reference/filtering
 *       https://developer.folk.app/api-reference/people/update-a-person
 *       https://developer.folk.app/api-reference/companies/create-a-company
 *       https://developer.folk.app/api-reference/notes/create-a-note
 *       https://developer.folk.app/api-reference/versioning
 *
 * folk's updates replace whole lists, so a person's addresses, numbers and companies are merged
 * into what the search found. It has no SIREN field. Its API exposes no workspace name, so the
 * connection is named after the key's owner.
 */

const PROVIDER = "folk";
const API = "https://api.folk.app/v1";
/** The version these calls were written against: folk recommends always naming one. */
const VERSION = "2025-06-09";
const MOST_PER_PAGE = 100;

interface FolkCompany {
  id: string;
  urls?: string[];
}

interface FolkPerson {
  id: string;
  emails?: string[];
  phones?: string[];
  companies?: { id: string }[];
}

type Items<T> = { data: { items: T[] } };
type One<T> = { data: T };

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const caller =
  (context: AdapterContext): Call =>
  <T>(path: string, method = "GET", body?: unknown) =>
    requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, jsonInit(method, { ...bearerJson(context.fields.apiKey), "x-api-version": VERSION }, body));

function folkRecords(call: Call): CrmRecords<FolkCompany, FolkPerson> {
  const list = async <T>(resource: string, filters: string) => (await call<Items<T>>(`/${resource}?${filters}&limit=${MOST_PER_PAGE}`)).data.items;

  /** `like` also matches part of a value, so the domain is compared on what comes back. */
  async function companyByDomain(domain: string): Promise<FolkCompany | null> {
    const companies = await list<FolkCompany>("companies", `filter[urls][like]=${encodeURIComponent(domain)}`);
    return companies.find((company) => company.urls?.some((url) => domainOf(url) === domain)) ?? null;
  }

  /** The doc doesn't say whether `eq` reads every address or only the primary, so `like` and a comparison here. */
  async function personByEmail(email: string): Promise<FolkPerson | null> {
    const people = await list<FolkPerson>("people", `filter[emails][like]=${encodeURIComponent(email)}`);
    return people.find((person) => holds(person.emails, email)) ?? null;
  }

  return {
    async findCompany(company: CrmCompany) {
      const domain = domainOf(company.website);
      const found = domain ? await companyByDomain(domain) : null;
      return found ?? (await list<FolkCompany>("companies", `filter[name][eq]=${encodeURIComponent(company.name)}`))[0] ?? null;
    },

    /** Never renames: a name clash fails an update, and the member's spelling is theirs. */
    async saveCompany(company, found) {
      if (!found) return (await call<One<FolkCompany>>("/companies", "POST", known({ name: company.name, urls: company.website ? [company.website] : null }))).data.id;
      const domain = domainOf(company.website);
      if (!company.website || found.urls?.some((url) => domainOf(url) === domain)) return found.id;
      await call(`/companies/${found.id}`, "PATCH", { urls: including(found.urls, company.website) });
      return found.id;
    },

    async findPerson(contact, companyId) {
      if (contact.email) return personByEmail(contact.email);
      return (await list<FolkPerson>("people", `filter[fullName][eq]=${encodeURIComponent(fullName(contact))}&filter[companies][in][id]=${companyId}`))[0] ?? null;
    },

    async savePerson(contact: CrmContact, companyId, found) {
      const names = known({ firstName: contact.firstName, lastName: contact.lastName, jobTitle: contact.role });
      if (!found) return (await call<One<FolkPerson>>("/people", "POST", { ...names, emails: including([], contact.email), phones: including([], contact.phone), companies: [{ id: companyId }] })).data.id;
      const companies = found.companies?.some((company) => company.id === companyId) ? found.companies : [...(found.companies ?? []), { id: companyId }];
      await call(`/people/${found.id}`, "PATCH", { ...names, emails: including(found.emails, contact.email), phones: including(found.phones, contact.phone), companies: companies.map(({ id }) => ({ id })) });
      return found.id;
    },

    async addNote(contact, personId) {
      await call("/notes", "POST", { entity: { id: personId }, visibility: "public", content: contact.note });
    },
  };
}

export const folk: Adapter = (context) => {
  const call = caller(context);
  return {
    check: () =>
      checkAccount(async () => {
        const { data } = await call<One<{ fullName?: string; email?: string }>>("/users/me");
        return data.fullName || data.email || PROVIDER;
      }),
    pushContact: (contact) => pushThrough(folkRecords(call), contact),
  };
};
