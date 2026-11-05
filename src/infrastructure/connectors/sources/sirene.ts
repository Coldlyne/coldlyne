import type { CompanyFacts } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { requestJson } from "../http";
import { checked } from "../checked";
import { nullWhenNotFound } from "./check";

/**
 * INSEE's Sirene directory: a company's establishments, addresses, headcount and activity, API
 * Sirene 3.11, the version in production (kept until mid-2028 alongside the V4 in beta).
 * How to call it: https://portail-api.insee.fr/catalog/api/2ba0e549-5587-3ef1-9082-99cd865de66f/doc?page=85c5657d-b1a1-4466-8565-7db1a194667b
 * Its schema: https://portail-api.insee.fr/catalog/api/2ba0e549-5587-3ef1-9082-99cd865de66f/doc?page=6548510e-c3e1-3099-be96-6edf02870699
 * Partial diffusion: https://portail-api.insee.fr/catalog/api/2ba0e549-5587-3ef1-9082-99cd865de66f/doc?page=ecf87666-b3f5-489b-b876-66b3f5389bfc
 * Versions: https://www.insee.fr/fr/information/9053325
 */
const API = "https://api.insee.fr/api-sirene/3.11";
const PROVIDER = "L’INSEE";
/** The most the API returns a page in JSON: past that, only the total says there are more. */
const MAX_ESTABLISHMENTS = 1000;
/** What the API writes in place of what a person asked not to publish. */
const NOT_DISCLOSED = "[ND]";

type Text = string | null | undefined;

interface LegalUnitPeriod {
  dateFin?: Text;
  etatAdministratifUniteLegale?: Text;
  denominationUniteLegale?: Text;
  nomUniteLegale?: Text;
  nomUsageUniteLegale?: Text;
  categorieJuridiqueUniteLegale?: Text;
  activitePrincipaleUniteLegale?: Text;
  nomenclatureActivitePrincipaleUniteLegale?: Text;
}

interface LegalUnit {
  siren: string;
  statutDiffusionUniteLegale?: Text;
  dateCreationUniteLegale?: Text;
  sigleUniteLegale?: Text;
  prenomUsuelUniteLegale?: Text;
  trancheEffectifsUniteLegale?: Text;
  anneeEffectifsUniteLegale?: Text;
  categorieEntreprise?: Text;
  periodesUniteLegale?: LegalUnitPeriod[];
}

interface EstablishmentPeriod {
  dateFin?: Text;
  etatAdministratifEtablissement?: Text;
  enseigne1Etablissement?: Text;
  denominationUsuelleEtablissement?: Text;
  activitePrincipaleEtablissement?: Text;
}

interface EstablishmentAddress {
  complementAdresseEtablissement?: Text;
  numeroVoieEtablissement?: Text;
  indiceRepetitionEtablissement?: Text;
  typeVoieEtablissement?: Text;
  libelleVoieEtablissement?: Text;
  distributionSpecialeEtablissement?: Text;
  codePostalEtablissement?: Text;
  libelleCommuneEtablissement?: Text;
  codeCedexEtablissement?: Text;
  libelleCedexEtablissement?: Text;
}

interface Establishment {
  siret: string;
  etablissementSiege?: boolean | null;
  trancheEffectifsEtablissement?: Text;
  anneeEffectifsEtablissement?: Text;
  adresseEtablissement?: EstablishmentAddress | null;
  periodesEtablissement?: EstablishmentPeriod[];
}

/** A value, unless the API has none or withholds it. */
const known = (value: Text) => (value && value !== NOT_DISCLOSED ? value : null);

/** The period still running: the API lists a company's whole history, and only the last one has no end. */
const currentPeriod = <P extends { dateFin?: Text }>(periods: readonly P[] | undefined): P | undefined => periods?.find((period) => !period.dateFin) ?? periods?.[0];

/** A company's legal name, or for a sole trader the name they go by. */
function nameOf(unit: LegalUnit, period: LegalUnitPeriod | undefined): string {
  const lastName = known(period?.nomUsageUniteLegale) ?? known(period?.nomUniteLegale);
  const person = lastName ? [known(unit.prenomUsuelUniteLegale), lastName].filter(Boolean).join(" ") : null;
  return known(period?.denominationUniteLegale) ?? person ?? known(unit.sigleUniteLegale) ?? unit.siren;
}

/** An address as a letter is written, the postal lines above the city; a large site's Cedex replaces the city on the envelope. */
function addressOf(address: EstablishmentAddress | null | undefined) {
  if (!address) return null;
  const street = [address.numeroVoieEtablissement, address.indiceRepetitionEtablissement, address.typeVoieEtablissement, address.libelleVoieEtablissement].map(known).filter(Boolean).join(" ");
  const cedex = [address.codeCedexEtablissement, address.libelleCedexEtablissement].map(known).filter(Boolean).join(" ");
  return {
    lines: [known(address.complementAdresseEtablissement), street, known(address.distributionSpecialeEtablissement)].flatMap((line) => line || []),
    postcode: known(address.codePostalEtablissement),
    city: known(address.libelleCommuneEtablissement),
    cedex: cedex || null,
  };
}

function establishmentFacts(establishment: Establishment) {
  const period = currentPeriod(establishment.periodesEtablissement);
  return {
    siret: establishment.siret,
    headOffice: establishment.etablissementSiege === true,
    /** The API has it open (A) or closed (F). */
    open: period?.etatAdministratifEtablissement === "A",
    name: known(period?.denominationUsuelleEtablissement) ?? known(period?.enseigne1Etablissement),
    activity: known(period?.activitePrincipaleEtablissement),
    headcountBand: known(establishment.trancheEffectifsEtablissement),
    headcountYear: known(establishment.anneeEffectifsEtablissement),
    address: addressOf(establishment.adresseEtablissement),
  };
}

/**
 * What Sirene knows about a company. Status P ("diffusion partielle", article R123-232-1 of the code
 * de commerce) means the person refused that their data be used for prospecting: it is a registry
 * opt-out like any other, and the company is never prospected.
 */
function companyFacts(unit: LegalUnit, establishments: readonly Establishment[], establishmentsTotal: number): CompanyFacts {
  const period = currentPeriod(unit.periodesUniteLegale);
  const facts = establishments.map(establishmentFacts);
  return {
    siren: unit.siren,
    name: nameOf(unit, period),
    facts: {
      active: period?.etatAdministratifUniteLegale === "A",
      registryOptOut: unit.statutDiffusionUniteLegale === "P",
      legalForm: known(period?.categorieJuridiqueUniteLegale),
      activity: known(period?.activitePrincipaleUniteLegale),
      /** Which list the code comes from: the codes change with NAF 2025, from January 2027. */
      activityNomenclature: known(period?.nomenclatureActivitePrincipaleUniteLegale),
      createdOn: known(unit.dateCreationUniteLegale),
      headcountBand: known(unit.trancheEffectifsUniteLegale),
      headcountYear: known(unit.anneeEffectifsUniteLegale),
      category: known(unit.categorieEntreprise),
      headOffice: facts.find((establishment) => establishment.headOffice) ?? null,
      establishments: facts,
      establishmentsTotal,
    },
  };
}

function clientOf({ fetch: fetchUrl, fields }: AdapterContext) {
  const headers = { "X-INSEE-Api-Key-Integration": fields.apiKey, accept: "application/json" };
  return <T>(path: string) => requestJson<T>(fetchUrl, PROVIDER, `${API}${path}`, { headers });
}

export const sirene: Adapter = (context) => {
  const get = clientOf(context);
  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { etatService, versionService } = await get<{ etatService?: string; versionService?: string }>("/informations");
        if (etatService !== "UP") return { ok: false, detail: "L’API Sirene est indisponible pour le moment." };
        return { ok: true, detail: `${["API Sirene", versionService].filter(Boolean).join(" ")}\u00A0: clé acceptée` };
      }),

    company: async (siren) => {
      const answer = await nullWhenNotFound(() => get<{ uniteLegale: LegalUnit }>(`/siren/${encodeURIComponent(siren)}`));
      if (!answer) return null;
      const params = new URLSearchParams({ q: `siren:${siren}`, nombre: String(MAX_ESTABLISHMENTS) });
      const found = await nullWhenNotFound(() => get<{ header?: { total?: number }; etablissements?: Establishment[] }>(`/siret?${params}`));
      const establishments = found?.etablissements ?? [];
      return companyFacts(answer.uniteLegale, establishments, found?.header?.total ?? establishments.length);
    },
  };
};
