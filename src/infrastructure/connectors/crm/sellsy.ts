import type { CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { bearerJson, requestJson } from "../http";
import { checkAccount, type CrmCompany, type CrmRecords, jsonHeaders, jsonInit, known, pushThrough, sameText } from "./push";

/**
 * Sellsy, through API v2 with a personal access (OAuth client credentials).
 *
 * Docs: https://docs.sellsy.com/api/v2/ (spec: https://docs.sellsy.com/api/v2/dist/sellsy.v2.latest.yaml)
 *       https://help.sellsy.com/fr/articles/5876615-types-d-acces-api
 *
 * Companies can't be searched by SIREN or website, only by exact name, so a namesake with another
 * SIREN is told apart on what comes back. The spec doesn't say whether PUT keeps the fields it
 * isn't sent: updates send what was found along with what changed, and are safe either way.
 */

const PROVIDER = "Sellsy";
const API = "https://api.sellsy.com/v2";
const TOKEN_URL = "https://login.sellsy.com/oauth2/access-tokens";
/** Renews a token this long before it expires, so none dies in the middle of a push. */
const TOKEN_MARGIN_MS = 60_000;
const CONTACT_FIELDS = ["civility", "first_name", "last_name", "email", "website", "phone_number", "mobile_number", "fax_number", "position", "birth_date", "note", "social"];
const COMPANY_FIELDS = ["name", "email", "website", "phone_number", "mobile_number", "fax_number", "reference", "note", "social"];

type SellsyRecord = { id: number } & Record<string, unknown>;
type LegalFrance = { siren?: string | null } & Record<string, unknown>;
type SellsyCompany = SellsyRecord & { website?: string | null; legal_france?: LegalFrance | null };
type Found<T> = { data: T[] };

const picked = (record: Record<string, unknown>, fields: string[]) => known(Object.fromEntries(fields.map((field) => [field, record[field]])));

/** A token per adapter, kept until it nears its end. */
function tokens(context: AdapterContext): () => Promise<string> {
  let current: { value: string; until: number } | null = null;
  return async () => {
    const now = context.now().getTime();
    if (current && now < current.until) return current.value;
    const client = { grant_type: "client_credentials", client_id: context.fields.clientId, client_secret: context.fields.clientSecret };
    const answer = await requestJson<{ access_token: string; expires_in: number }>(context.fetch, PROVIDER, TOKEN_URL, jsonInit("POST", jsonHeaders({}), client));
    current = { value: answer.access_token, until: now + answer.expires_in * 1000 - TOKEN_MARGIN_MS };
    return answer.access_token;
  };
}

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

function caller(context: AdapterContext): Call {
  const token = tokens(context);
  return async <T>(path: string, method = "GET", body?: unknown) => requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, jsonInit(method, bearerJson(await token()), body));
}

/** What Coldlyne knows of a contact, under Sellsy's names. */
const contactFields = (contact: CrmContact) => known({ first_name: contact.firstName, last_name: contact.lastName, email: contact.email, phone_number: contact.phone, position: contact.role });

/** Of the companies under this name, the one with this SIREN, or one with none; never another's. */
function sameCompany(found: SellsyCompany[], siren: string | null): SellsyCompany | null {
  const sirenOf = (company: SellsyCompany) => company.legal_france?.siren || null;
  return found.find((company) => siren && sirenOf(company) === siren) ?? found.find((company) => !siren || !sirenOf(company)) ?? null;
}

function sellsyRecords(call: Call): CrmRecords<SellsyCompany, SellsyRecord> {
  return {
    async findCompany(company: CrmCompany) {
      const { data } = await call<Found<SellsyCompany>>("/companies/search", "POST", { filters: { name: company.name } });
      return sameCompany(data, company.siren);
    },

    /** Only fills in what's missing: the name, website and SIREN a member saved stay theirs. */
    async saveCompany(company, found) {
      const legal = company.siren ? { legal_france: { siren: company.siren } } : {};
      if (!found) return String((await call<SellsyRecord>("/companies", "POST", { type: "prospect", ...known({ name: company.name, website: company.website }), ...legal })).id);
      const missingWebsite = company.website && !found.website;
      const missingSiren = company.siren && !found.legal_france?.siren;
      if (!missingWebsite && !missingSiren) return String(found.id);
      const legal_france = known({ ...(found.legal_france ?? {}), ...(missingSiren ? { siren: company.siren } : {}) });
      await call(`/companies/${found.id}`, "PUT", { ...picked(found, COMPANY_FIELDS), ...(missingWebsite ? { website: company.website } : {}), legal_france });
      return String(found.id);
    },

    async findPerson(contact, companyId) {
      if (contact.email) return (await call<Found<SellsyRecord>>("/contacts/search", "POST", { filters: { email: contact.email } })).data[0] ?? null;
      const { data } = await call<Found<SellsyRecord>>("/contacts/search", "POST", { filters: { last_name: contact.lastName, companies: [Number(companyId)] } });
      return data.find((person) => !contact.firstName || !person.first_name || sameText(person.first_name, contact.firstName)) ?? null;
    },

    async savePerson(contact, _companyId, found) {
      const fields = contactFields(contact);
      if (!found) return String((await call<SellsyRecord>("/contacts", "POST", fields)).id);
      if (Object.entries(fields).some(([field, value]) => found[field] !== value)) await call(`/contacts/${found.id}`, "PUT", { ...picked(found, CONTACT_FIELDS), ...fields });
      return String(found.id);
    },

    /** Sellsy answers 200 to a link already made, so this can run every time. */
    async link(personId, companyId) {
      await call(`/companies/${companyId}/contacts/${personId}`, "POST");
    },

    async addNote(contact, personId) {
      await call("/comments", "POST", { description: contact.note, related: [{ type: "contact", id: Number(personId) }] });
    },
  };
}

/** The account's name; a restricted staff view leaves it out, so the staff member's name stands in. */
async function accountName(call: Call): Promise<string> {
  const staff = await call<{ firstname?: string; lastname?: string; _embed?: { account?: { name?: string } } }>("/staffs/me?embed[]=account");
  return staff._embed?.account?.name || [staff.firstname, staff.lastname].filter(Boolean).join(" ") || PROVIDER;
}

export const sellsy: Adapter = (context) => {
  const call = caller(context);
  return {
    check: () => checkAccount(() => accountName(call)),
    pushContact: (contact) => pushThrough(sellsyRecords(call), contact),
  };
};
