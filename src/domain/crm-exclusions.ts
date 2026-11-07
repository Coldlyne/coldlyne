import { isPublicMailDomain, normalizedEmail, siteDomain, socialProfile } from "./contacts";
import { frenchPhoneE164, internationalPhoneE164, checkedSiren } from "./french-numbers";
import { CHANNEL_NAMES, type Channel } from "./sequences";

/**
 * What a linked CRM's customers and open deals become on a workspace's suppression list. Addresses,
 * numbers, profiles and domains are what the list already matches; a company as a whole is kept too,
 * by its SIREN and its name, since a customer entered by hand may have nothing else and someone found
 * in the registry may have no address yet. A wrong match only spares a namesake a message.
 */

export interface OffLimitsEntry {
  company: { name: string; domain: string | null; siren: string | null } | null;
  people: { emails: string[]; phones: string[]; linkedinUrl: string | null }[];
}

const SIREN_KEY = "siren:";
const NAME_KEY = "company:";

/** Words that change with the paperwork, not with the company. */
const LEGAL_FORMS = new Set(["sa", "sas", "sasu", "sarl", "eurl", "sci", "snc", "scop", "selarl", "ltd", "llc", "inc", "gmbh"]);

const nameKey = (name: string) => {
  const words = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\./g, "").split(/[^a-z0-9]+/).filter((word) => word && !LEGAL_FORMS.has(word));
  return words.length ? `${NAME_KEY}${words.join(" ")}` : null;
};

const sirenKey = (siren: string | null) => {
  const checked = siren && checkedSiren(siren);
  return checked ? `${SIREN_KEY}${checked}` : null;
};

/** A company's own domain: a provider's would stop everyone with an address there, for one customer who has one. */
const companyDomain = (domain: string | null) => {
  const bare = domain?.trim().toLowerCase();
  return bare && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(bare) && !isPublicMailDomain(bare) ? bare : null;
};

const profileOf = (url: string | null) => (url ? (socialProfile(url)?.value ?? null) : null);

const valuesOfPerson = ({ emails, phones, linkedinUrl }: OffLimitsEntry["people"][number]) => [...emails.map(normalizedEmail), ...phones.map((phone) => frenchPhoneE164(phone) ?? internationalPhoneE164(phone)), profileOf(linkedinUrl)];

const valuesOfCompany = (company: OffLimitsEntry["company"]) => (company ? [companyDomain(company.domain), sirenKey(company.siren), nameKey(company.name)] : []);

/** The list's values for these, each once. What can't be read is left out rather than guessed at. */
export function exclusionsOf(entries: readonly OffLimitsEntry[]): string[] {
  const values = entries.flatMap(({ company, people }) => [...valuesOfCompany(company), ...people.flatMap(valuesOfPerson)]);
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** Whether the list holds this company as a whole: by its site's domain, its SIREN or its name. Someone there may have no detail to match. */
export function companyIsExcluded(company: { name: string; siren: string | null; website: string | null }, refused: ReadonlySet<string>): boolean {
  return [siteDomain(company.website), sirenKey(company.siren), nameKey(company.name)].some((value) => value !== null && refused.has(value));
}

const LONGEST_NOTE = 4000;

/** What a reply says on the CRM's side. Their words are data there as they are here. */
export const replyNote = (channel: Channel, detail: string | null) => {
  const where = `A répondu par ${CHANNEL_NAMES[channel]}`;
  return detail?.trim() ? `${where} : ${detail.trim().slice(0, LONGEST_NOTE)}` : `${where}.`;
};
