import { fromRegistry, type RegistryApiCompany, type RegistryCompany } from "@/domain/registry";

const API = "https://recherche-entreprises.api.gouv.fr/search";

/** The registry asks to slow down: worth waiting for, unlike any other refusal. */
class RegistryBusy extends Error {}
/** The most the API returns a page. */
export const REGISTRY_PAGE_SIZE = 25;

/** What to look for in the registry: activity codes, legal forms, a department or postcode, a size band, words. */
export interface RegistryQuery {
  activities?: string[];
  legalForms?: string[];
  department?: string;
  postcode?: string;
  /** INSEE's headcount bands: NN (none), 00, 01 (1–2), 02 (3–5), 03 (6–9), 11 (10–19)… */
  sizes?: string[];
  words?: string;
  page?: number;
}

export interface RegistryPage {
  companies: RegistryCompany[];
  /** How many match (the API counts up to 10,000). */
  total: number;
  page: number;
  pages: number;
}

type Fetch = (url: string) => Promise<Response>;

/** Active companies matching the query, a page at a time. */
export async function searchRegistry(query: RegistryQuery, fetchUrl: Fetch = fetch): Promise<RegistryPage> {
  const params = new URLSearchParams({ etat_administratif: "A", per_page: String(REGISTRY_PAGE_SIZE), page: String(query.page ?? 1) });
  if (query.activities?.length) params.set("activite_principale", query.activities.join(","));
  if (query.legalForms?.length) params.set("nature_juridique", query.legalForms.join(","));
  if (query.department) params.set("departement", query.department);
  if (query.postcode) params.set("code_postal", query.postcode);
  if (query.sizes?.length) params.set("tranche_effectif_salarie", query.sizes.join(","));
  if (query.words) params.set("q", query.words);
  const body = await read(fetchUrl, `${API}?${params}`);
  return { companies: (body.results ?? []).map(fromRegistry), total: body.total_results ?? 0, page: body.page ?? 1, pages: body.total_pages ?? 0 };
}

/** The API allows 400 requests a minute: this stays under it, and what it asks to wait for, it waits for. */
const BETWEEN_LOOKUPS_MS = 180;
const WHEN_BUSY_MS = 2000;
const TRIES = 3;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookUp(siren: string, fetchUrl: Fetch): Promise<RegistryCompany | undefined> {
  for (let tries = 1; ; tries++) {
    try {
      return (await searchRegistry({ words: siren }, fetchUrl)).companies.find((candidate) => candidate.siren === siren);
    } catch (error) {
      if (!(error instanceof RegistryBusy) || tries === TRIES) throw error;
      await wait(WHEN_BUSY_MS * tries);
    }
  }
}

/**
 * These companies by their SIREN; one the registry doesn't know is left out. One after the other
 * and paced: the API is shared, and a burst of lookups is refused whatever the reason for it.
 */
export async function companiesBySiren(sirens: readonly string[], fetchUrl: Fetch = fetch): Promise<Map<string, RegistryCompany>> {
  const found = new Map<string, RegistryCompany>();
  let first = true;
  for (const siren of new Set(sirens)) {
    if (!first) await wait(BETWEEN_LOOKUPS_MS);
    first = false;
    const company = await lookUp(siren, fetchUrl);
    if (company) found.set(siren, company);
  }
  return found;
}

/** How many active companies a person directs, by their names in the registry. */
export async function companiesDirectedBy(firstName: string | null, lastName: string, fetchUrl: Fetch = fetch): Promise<number> {
  const params = new URLSearchParams({ etat_administratif: "A", per_page: "1", type_personne: "dirigeant", nom_personne: lastName });
  if (firstName) params.set("prenoms_personne", firstName);
  return (await read(fetchUrl, `${API}?${params}`)).total_results ?? 0;
}

async function read(fetchUrl: Fetch, url: string): Promise<{ results?: RegistryApiCompany[]; total_results?: number; page?: number; total_pages?: number }> {
  const response = await fetchUrl(url);
  if (response.status === 429) throw new RegistryBusy("Le registre des entreprises limite le nombre de demandes\u00a0: réessayez dans un moment.");
  if (!response.ok) throw new Error(`Le registre des entreprises a répondu ${response.status}.`);
  return response.json();
}
