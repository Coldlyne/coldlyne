/**
 * The official business announcements (BODACC), as the state publishes them on its open data:
 * https://bodacc-datadila.opendatasoft.com/explore/dataset/annonces-commerciales/api/
 *
 * This is what makes a campaign timely: each announcement is an event worth writing about ("every
 * holding created this week", "every company that changed its director last month", "whoever just
 * bought a business in the Rhône"), which a static list of companies can't say.
 */

/**
 * The families worth prospecting from. The dataset has more (filed accounts, 26 million of them, and
 * conciliations), which are no event a company would expect a message about.
 */
export const BODACC_FAMILIES = ["creation", "immatriculation", "modification", "vente", "radiation", "collective"] as const;

export type BodaccFamily = (typeof BODACC_FAMILIES)[number];

export interface BodaccQuery {
  /** All of `BODACC_FAMILIES` when left out. */
  families?: readonly BodaccFamily[];
  /** Only the modifications that change who runs the company ("Modification de l'administration"). */
  onlyDirectorChanges?: boolean;
  /** Publication dates, included, YYYY-MM-DD. */
  publishedFrom?: string;
  publishedTo?: string;
  department?: string;
  words?: string;
  page?: number;
}

export interface BodaccAnnouncement {
  id: string;
  family: BodaccFamily;
  publishedOn: string;
  /** Every company it names, both sides of a sale included; none for what has no number (a co-ownership). */
  sirens: string[];
  companyName: string | null;
  city: string | null;
  department: string | null;
  /** What happened, in the announcement's own words. */
  summary: string | null;
  /** The announcement on bodacc.fr, to say where this comes from. */
  url: string | null;
}

/** One record, as the API returns it (the fields read here). Its details are JSON written inside strings. */
export interface BodaccApiRecord {
  id: string;
  familleavis?: string | null;
  familleavis_lib?: string | null;
  dateparution?: string | null;
  commercant?: string | null;
  ville?: string | null;
  numerodepartement?: string | null;
  registre?: string[] | string | null;
  url_complete?: string | null;
  listepersonnes?: unknown;
  listeetablissements?: unknown;
  acte?: unknown;
  modificationsgenerales?: unknown;
  radiationaurcs?: unknown;
  jugement?: unknown;
}

const DIRECTOR_CHANGE_WORDS = "administration";

/** A string in the API's query language: the words come from a conversation and must stay words. */
const quoted = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;

function dateLiteral(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date attendue au format AAAA-MM-JJ\u00A0: ${date}`);
  return `date'${date}'`;
}

/**
 * The query, in the API's language (ODSQL). Initial notices only: a correction or a cancellation
 * of last week's announcement isn't a new event, and would trigger the same campaign twice.
 */
export function bodaccWhere(query: BodaccQuery): string {
  const families = query.families?.length ? query.families : BODACC_FAMILIES;
  return [
    'typeavis="annonce"',
    `familleavis in (${families.map(quoted).join(",")})`,
    query.onlyDirectorChanges ? `modificationsgenerales like ${quoted(DIRECTOR_CHANGE_WORDS)}` : null,
    query.publishedFrom ? `dateparution>=${dateLiteral(query.publishedFrom)}` : null,
    query.publishedTo ? `dateparution<=${dateLiteral(query.publishedTo)}` : null,
    query.department ? `numerodepartement=${quoted(query.department)}` : null,
    query.words ? `search(${quoted(query.words)})` : null,
  ]
    .filter(Boolean)
    .join(" AND ");
}

const isBodaccFamily = (family: string | null | undefined): family is BodaccFamily => BODACC_FAMILIES.includes(family as BodaccFamily);

/** An announcement of a family Coldlyne prospects from, or nothing for the others. */
export function fromBodacc(raw: BodaccApiRecord): BodaccAnnouncement[] {
  if (!isBodaccFamily(raw.familleavis) || !raw.dateparution) return [];
  return [
    {
      id: raw.id,
      family: raw.familleavis,
      publishedOn: raw.dateparution,
      sirens: sirensIn(raw.registre),
      companyName: companyNameOf(raw),
      city: raw.ville ?? null,
      department: raw.numerodepartement ?? null,
      summary: summaryOf(raw),
      url: raw.url_complete ?? null,
    },
  ];
}

/** The register gives each number twice, ["917463051", "917 463 051"], and a sale gives both parties'. */
function sirensIn(registre: BodaccApiRecord["registre"]): string[] {
  const written = [registre ?? []].flat().flatMap((entry) => entry.split(","));
  const sirens = written.map((entry) => entry.replace(/\D/g, "")).filter((digits) => digits.length === 9);
  return [...new Set(sirens)];
}

/** A JSON string inside the record, as an object, or nothing when it isn't one. */
function detailsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    return detailsOf(JSON.parse(value));
  } catch {
    return {};
  }
}

const textIn = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Lists hold one object, or several in an array: the first is the main party. */
const firstOf = (value: unknown) => detailsOf(Array.isArray(value) ? value[0] : value);

/** Its legal name, or the trade name of a sole trader. Otherwise the "merchant" as written, which for a sale names both parties. */
function companyNameOf(raw: BodaccApiRecord): string | null {
  const person = firstOf(detailsOf(raw.listepersonnes).personne);
  return textIn(person.denomination) ?? textIn(person.nomCommercial) ?? textIn(raw.commercant);
}

/** What happened and, for a business, what it does. A judgment's free text is left out: it names people. */
function summaryOf(raw: BodaccApiRecord): string | null {
  const parts = [whatHappened(raw), textIn(firstOf(detailsOf(raw.listeetablissements).etablissement).activite)].filter(Boolean);
  return parts.length ? parts.join(" — ") : null;
}

function whatHappened(raw: BodaccApiRecord): string | null {
  const act = detailsOf(raw.acte);
  const judgment = detailsOf(raw.jugement);
  return (
    textIn(detailsOf(raw.modificationsgenerales).descriptif) ??
    textIn(detailsOf(act.creation).categorieCreation) ??
    textIn(detailsOf(act.immatriculation).categorieImmatriculation) ??
    textIn(detailsOf(act.vente).categorieVente) ??
    textIn(judgment.nature) ??
    textIn(detailsOf(raw.radiationaurcs).commentaire) ??
    textIn(raw.familleavis_lib)
  );
}
