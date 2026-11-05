import type { Check, CrmContact } from "@/application/ports";
import { ProviderError } from "../http";

/**
 * What every CRM adapter shares: the same idempotent push (company first, so a person without an
 * email can be found by name within it; then the person; then the link and the note), and the
 * same check that turns a refusal into the member's words.
 */

export type CrmCompany = CrmContact["company"];

/**
 * One CRM's records, as the shared push needs them. Ids are the CRM's own. What a search finds is
 * handed back when saving, so a CRM whose updates replace whole lists can merge into them.
 */
export interface CrmRecords<FoundCompany = string, FoundPerson = string> {
  /** The company already in the CRM: by SIREN, domain or name, as far as the CRM can search. */
  findCompany(company: CrmCompany): Promise<FoundCompany | null>;
  /** Creates the company, or completes the one found; returns its id. */
  saveCompany(company: CrmCompany, found: FoundCompany | null): Promise<string>;
  /** The person already in the CRM: by email, or by name within their company. */
  findPerson(contact: CrmContact, companyId: string): Promise<FoundPerson | null>;
  /** Creates the person in their company, or updates the one found; returns their id. */
  savePerson(contact: CrmContact, companyId: string, found: FoundPerson | null): Promise<string>;
  /** For CRMs that link people and companies apart from saving them. */
  link?(personId: string, companyId: string): Promise<void>;
  /** Adds the contact's note on the person. */
  addNote(contact: CrmContact, personId: string, companyId: string): Promise<void>;
}

/** Creates or updates the company and the person, links them, and adds the note on the person if there is one. */
export async function pushThrough<FoundCompany, FoundPerson>(records: CrmRecords<FoundCompany, FoundPerson>, contact: CrmContact): Promise<{ externalId: string }> {
  const companyId = await records.saveCompany(contact.company, await records.findCompany(contact.company));
  const personId = await records.savePerson(contact, companyId, await records.findPerson(contact, companyId));
  await records.link?.(personId, companyId);
  if (contact.note) await records.addNote(contact, personId, companyId);
  return { externalId: personId };
}

/** Runs a cheap authenticated call; the account's name becomes the connection's label. */
export async function checkAccount(account: () => Promise<string>): Promise<Check> {
  try {
    const name = await account();
    return { ok: true, detail: `compte « ${name} »`, label: name };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, detail: error.message };
    throw error;
  }
}

/** "Jeanne Dupont-Martin", or the last name alone. */
export const fullName = (contact: CrmContact) => [contact.firstName, contact.lastName].filter(Boolean).join(" ");

/** The site's bare host, "acme.fr" for "https://www.acme.fr/offres", or null. */
export function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The fields that have a value: an update never erases what the CRM knows and Coldlyne doesn't. */
export function known<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== "")) as Partial<T>;
}

/** A request's method, headers and JSON body, when it has one. */
export const jsonInit = (method: string, headers: HeadersInit, body?: unknown): RequestInit => ({ method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

/** JSON request headers with a provider's own authentication header. */
export const jsonHeaders = (authentication: Record<string, string>): HeadersInit => ({ ...authentication, "content-type": "application/json", accept: "application/json" });

/** Whether a CRM's name or address is this one, whatever its case and surrounding spaces. */
export const sameText = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

const sameValue = (a: string, b: string) => a.replace(/\s/g, "").toLowerCase() === b.replace(/\s/g, "").toLowerCase();

/** Whether a list of addresses or numbers holds this one, whatever its case and spacing. */
export const holds = (list: string[] = [], value: string) => list.some((item) => sameValue(item, value));

/** The list with this value at its end, unless it is already there: the first value stays primary. */
export const including = (list: string[] = [], value: string | null) => (!value || holds(list, value) ? list : [...list, value]);

/**
 * The address of an account on its own subdomain. The member types the subdomain, and the API key
 * goes wherever it points: anything but a plain label could send the key to another host.
 */
export function onSubdomain(provider: string, subdomain: string, domain: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain)) throw new ProviderError(provider, 400, `Le sous-domaine ${provider} ne contient que des lettres, des chiffres et des tirets, comme «\u00a0northwind\u00a0».`);
  return `https://${subdomain}.${domain}`;
}
