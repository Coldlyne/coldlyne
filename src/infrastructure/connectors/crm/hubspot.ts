import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { bearerJson, requestJson } from "../http";
import { checkAccount, type CrmCompany, type CrmRecords, domainOf, jsonInit, known, pushThrough } from "./push";

/**
 * HubSpot, through its CRM v3 objects and search, with a service key or a private app's token
 * (both are bearer tokens). v3 is HubSpot's legacy path, supported until September 2027; it is the
 * one its service keys are documented on.
 *
 * Docs: https://developers.hubspot.com/docs/api-reference/legacy/account/account-information/get-account-details
 *       https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
 *       https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide
 *       https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide
 *       https://developers.hubspot.com/docs/api-reference/crm-associations-v4/guide
 *       https://developers.hubspot.com/docs/api-reference/latest/crm/activities/notes/guide
 *       https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys
 *
 * A company has no SIREN property by default, so it is found by domain, then by name. Search can
 * lag behind a creation by a few moments, HubSpot warns: two pushes that close can create twice.
 */

const PROVIDER = "HubSpot";
const API = "https://api.hubapi.com";
/** HubSpot's own association type: a note on a contact. */
const NOTE_TO_CONTACT = 202;

interface Found {
  id: string;
  properties: Record<string, string | null>;
}

/** What Coldlyne knows of a contact, under HubSpot's property names. */
const contactProperties = (contact: CrmContact) => known({ email: contact.email, firstname: contact.firstName, lastname: contact.lastName, phone: contact.phone, jobtitle: contact.role, company: contact.company.name });

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const caller =
  (context: AdapterContext): Call =>
  <T>(path: string, method = "GET", body?: unknown) =>
    requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, jsonInit(method, bearerJson(context.fields.accessToken), body));

function hubspotRecords(call: Call, context: AdapterContext): CrmRecords<Found, Found> {
  /** The first record whose properties all equal these values. */
  async function search(object: string, values: Record<string, string | null | undefined>, properties: string[] = []): Promise<Found | null> {
    const filters = Object.entries(known(values)).map(([propertyName, value]) => ({ propertyName, operator: "EQ", value }));
    const { results } = await call<{ results: Found[] }>(`/crm/v3/objects/${object}/search`, "POST", { filterGroups: [{ filters }], properties, limit: 1 });
    return results[0] ?? null;
  }

  return {
    async findCompany(company: CrmCompany) {
      const domain = domainOf(company.website);
      return (domain ? await search("companies", { domain }, ["domain"]) : null) ?? search("companies", { name: company.name }, ["domain"]);
    },

    /** Only fills in a missing domain: the name and domain a member chose stay theirs. */
    async saveCompany(company, found) {
      const domain = domainOf(company.website);
      if (!found) return (await call<Found>("/crm/v3/objects/companies", "POST", { properties: known({ name: company.name, domain }) })).id;
      if (domain && !found.properties.domain) await call(`/crm/v3/objects/companies/${found.id}`, "PATCH", { properties: { domain } });
      return found.id;
    },

    findPerson(contact) {
      if (contact.email) return search("contacts", { email: contact.email });
      return search("contacts", { firstname: contact.firstName, lastname: contact.lastName, company: contact.company.name });
    },

    async savePerson(contact, _companyId, found) {
      if (!found) return (await call<Found>("/crm/v3/objects/contacts", "POST", { properties: contactProperties(contact) })).id;
      await call(`/crm/v3/objects/contacts/${found.id}`, "PATCH", { properties: contactProperties(contact) });
      return found.id;
    },

    /** v3 has no single-record call for this: v4's default association is the documented one, and repeating it is harmless. */
    async link(personId, companyId) {
      await call(`/crm/v4/objects/contact/${personId}/associations/default/company/${companyId}`, "PUT");
    },

    async addNote(contact, personId) {
      const properties = { hs_timestamp: context.now().toISOString(), hs_note_body: contact.note };
      await call("/crm/v3/objects/notes", "POST", { properties, associations: [{ to: { id: personId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }] });
    },
  };
}

export const hubspot: Adapter = (context) => {
  const call = caller(context);
  return {
    check: () =>
      checkAccount(async () => {
        const account = await call<{ portalId: number; portalName?: string }>("/account-info/v3/details");
        return account.portalName || `Portail ${account.portalId}`;
      }),
    pushContact: (contact) => pushThrough(hubspotRecords(call, context), contact),
  };
};
