/**
 * A company as the French company registry describes it (recherche-entreprises.api.gouv.fr, the
 * state's open data on INSEE's Sirene and the RNE), reduced to what prospecting needs: who it is,
 * what it does, where, and who runs it. Directors' birth dates and nationalities are left out.
 */
export interface RegistryCompany {
  siren: string;
  name: string;
  /** The legal form's code: 5710 SAS, 5720 SASU, 5499 SARL, 5498 EURL, 6540 SCI… */
  legalForm: string | null;
  /** The activity's NAF code: 64.20Z for holdings. */
  activity: string | null;
  /** The registered office's street, where a letter goes. */
  street: string | null;
  postcode: string | null;
  city: string | null;
  createdOn: string | null;
  active: boolean;
  /** It refused commercial use of its data: never prospected. */
  registryOptOut: boolean;
  directors: RegistryDirector[];
}

export interface RegistryDirector {
  /** A person, or a company directing it (a holding presiding a SAS). */
  kind: "person" | "company";
  firstName: string | null;
  lastName: string;
  role: string | null;
}

/** The registry's answer for one company, as its API returns it (the fields read here). */
export interface RegistryApiCompany {
  siren: string;
  nom_complet?: string | null;
  nom_raison_sociale?: string | null;
  nature_juridique?: string | null;
  activite_principale?: string | null;
  etat_administratif?: string | null;
  date_creation?: string | null;
  opposition_diffusion_commerciale?: boolean | null;
  siege?: { numero_voie?: string | null; type_voie?: string | null; libelle_voie?: string | null; code_postal?: string | null; libelle_commune?: string | null } | null;
  dirigeants?: { type_dirigeant?: string | null; nom?: string | null; prenoms?: string | null; denomination?: string | null; qualite?: string | null }[] | null;
}

export function fromRegistry(raw: RegistryApiCompany): RegistryCompany {
  return {
    siren: raw.siren,
    name: raw.nom_complet ?? raw.nom_raison_sociale ?? raw.siren,
    legalForm: raw.nature_juridique ?? null,
    activity: raw.activite_principale ?? null,
    street: [raw.siege?.numero_voie, raw.siege?.type_voie, raw.siege?.libelle_voie].filter(Boolean).join(" ") || null,
    postcode: raw.siege?.code_postal ?? null,
    city: raw.siege?.libelle_commune ?? null,
    createdOn: raw.date_creation ?? null,
    active: raw.etat_administratif === "A",
    registryOptOut: raw.opposition_diffusion_commerciale === true,
    directors: (raw.dirigeants ?? []).flatMap(directorOf),
  };
}

function directorOf(raw: NonNullable<RegistryApiCompany["dirigeants"]>[number]): RegistryDirector[] {
  if (raw.type_dirigeant === "personne morale") return raw.denomination ? [{ kind: "company", firstName: null, lastName: raw.denomination, role: raw.qualite ?? null }] : [];
  if (!raw.nom) return [];
  return [{ kind: "person", firstName: firstNameOf(raw.prenoms), lastName: titleCase(raw.nom), role: raw.qualite ?? null }];
}

/** The first of a director's given names, the one they go by: the registry lists them all ("JEAN PIERRE MARIE" → "Jean"). */
export function firstNameOf(names: string | null | undefined): string | null {
  const first = names?.trim().split(/\s+/)[0];
  return first ? titleCase(first) : null;
}

/** "DUPONT-MARTIN" → "Dupont-Martin". */
export const titleCase = (text: string) => text.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());

/** Whether a company may be prospected: active, and it didn't refuse commercial use of its data. */
export const prospectable = (company: RegistryCompany) => company.active && !company.registryOptOut;
