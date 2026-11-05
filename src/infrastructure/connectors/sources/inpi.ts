import type { CompanyFacts } from "@/application/ports";
import { firstNameOf, titleCase, type RegistryDirector } from "@/domain/registry";
import type { Adapter, AdapterContext } from "../adapter";
import { bearerJson, ProviderError, requestJson } from "../http";
import { checked } from "../checked";
import { nullWhenNotFound } from "./check";

/**
 * The national company register (RNE) kept by INPI: who runs a company and what it has filed.
 * Formalities (login, /companies/{siren}, the JSON, diffusionCommerciale):
 * https://www.inpi.fr/sites/default/files/documentation%20technique%20API%20formalit%C3%A9s_v3.0.pdf
 * Deeds (/companies/{siren}/attachments): https://www.inpi.fr/sites/default/files/documentation%20technique%20API%20Actes%20v3.0_1.pdf
 * Annual accounts: https://www.inpi.fr/sites/default/files/documentation%20technique%20API_comptes_annuels%20v4_0.pdf
 *
 * The real answer wraps the documented JSON in `formality`, which a recorded answer shows and the
 * documents don't: https://github.com/fma16/french-company-search/blob/main/assets/mocked-api-responses.json
 *
 * The formalities and deeds documents have reusers commit not to use personal data "à des fins de
 * prospection, notamment commerciale", more strictly than the RNE licence itself
 * (https://www.inpi.fr/sites/default/files/Licence%20donn%C3%A9es%20RNE_2024_0.pdf): to settle
 * before anyone is written to because this source named them.
 */
const API = "https://registre-national-entreprises.inpi.fr/api";
const PROVIDER = "L’INPI";

type Text = string | null | undefined;

interface Person {
  nom?: Text;
  nomUsage?: Text;
  prenoms?: string[] | string | null;
}

interface Power {
  /** A role that has ended: the register keeps it for its history. */
  actif?: boolean | null;
  typeDePersonne?: Text;
  roleEntreprise?: Text;
  individu?: { descriptionPersonne?: Person | null } | null;
  entreprise?: { denomination?: Text; siren?: Text } | null;
}

/** Who is registered: a legal person, a sole trader or a farm, whose blocks read alike. */
interface Registrant {
  identite?: {
    entreprise?: { denomination?: Text; formeJuridique?: Text; codeApe?: Text; dateImmat?: Text } | null;
    entrepreneur?: { descriptionPersonne?: Person | null } | null;
  } | null;
  composition?: { pouvoirs?: Power[] | null } | null;
  adresseEntreprise?: { adresse?: { numVoie?: Text; typeVoie?: Text; voie?: Text; codePostal?: Text; commune?: Text } | null } | null;
}

interface CompanyAnswer {
  siren?: Text;
  formality?: {
    /** False when the declarant refused that their data be used for prospecting (R. 123-320 of the code de commerce). */
    diffusionCommerciale?: boolean | string | null;
    /** N or P when INSEE doesn't let its data be passed on. */
    diffusionINSEE?: Text;
    content?: { personneMorale?: Registrant | null; personnePhysique?: Registrant | null; exploitation?: Registrant | null; natureCreation?: { dateCreation?: Text; formeJuridique?: Text } | null } | null;
  } | null;
}

interface Filing {
  id: string;
  dateDepot?: Text;
  confidentiality?: Text;
  /** A removed document, which a reuser must forget. */
  deleted?: boolean | null;
}

interface Deed extends Filing {
  typeRdd?: { typeActe?: Text; decision?: Text }[] | null;
}

interface AnnualAccounts extends Filing {
  dateCloture?: Text;
  typeBilan?: Text;
}

interface Attachments {
  actes?: Deed[] | null;
  bilans?: AnnualAccounts[] | null;
}

/**
 * The register gives roles as codes. INPI publishes no list of them, so these are the ones checked
 * against the state's registry (recherche-entreprises.api.gouv.fr) on real companies: any other
 * stays a bare code rather than a label someone might believe.
 */
const ROLES: Readonly<Record<string, string>> = {
  "30": "Gérant",
  "51": "Président du conseil d’administration",
  "53": "Directeur général",
  "61": "Président du conseil de surveillance",
  "64": "Membre du conseil de surveillance",
  "65": "Administrateur",
  "73": "Président",
  "75": "Associé indéfiniment responsable",
  "99": "Autre",
};

/** The company's auditors are listed among its powers, but they don't run it. */
const AUDITORS = new Set(["71", "72"]);

interface InpiDirector extends RegistryDirector {
  roleCode: string | null;
  /** For a company directing this one. */
  siren?: string | null;
}

function personDirector(person: Person | null | undefined, roleCode: string | null, role: string | null): InpiDirector[] {
  const lastName = person?.nomUsage ?? person?.nom;
  if (!lastName) return [];
  return [{ kind: "person", firstName: firstNameOf([person?.prenoms ?? []].flat()[0]), lastName: titleCase(lastName), role, roleCode }];
}

function directorOf(power: Power): InpiDirector[] {
  const roleCode = power.roleEntreprise ?? null;
  if (power.actif === false || (roleCode && AUDITORS.has(roleCode))) return [];
  const role = roleCode ? (ROLES[roleCode] ?? null) : null;
  if (power.typeDePersonne !== "ENTREPRISE") return personDirector(power.individu?.descriptionPersonne, roleCode, role);
  const denomination = power.entreprise?.denomination;
  return denomination ? [{ kind: "company", firstName: null, lastName: denomination, role, roleCode, siren: power.entreprise?.siren ?? null }] : [];
}

/**
 * The people and companies who run it. A sole trader runs their own business and has no powers listed.
 * Nobody's birth date or home address is kept: prospecting needs neither.
 */
function directorsOf(registrant: Registrant | null | undefined): InpiDirector[] {
  const directors = (registrant?.composition?.pouvoirs ?? []).flatMap(directorOf);
  const entrepreneur = registrant?.identite?.entrepreneur?.descriptionPersonne;
  return directors.length ? directors : personDirector(entrepreneur, null, entrepreneur ? "Entrepreneur" : null);
}

function filingsOf(attachments: Attachments | null) {
  const current = <F extends Filing>(filings: readonly F[] | null | undefined) => (filings ?? []).filter((filing) => !filing.deleted);
  return {
    deeds: current(attachments?.actes).map((deed) => ({
      id: deed.id,
      filedOn: deed.dateDepot ?? null,
      confidentiality: deed.confidentiality ?? null,
      kinds: (deed.typeRdd ?? []).flatMap((kind) => kind.typeActe ?? []),
    })),
    annualAccounts: current(attachments?.bilans).map((accounts) => ({
      id: accounts.id,
      filedOn: accounts.dateDepot ?? null,
      closedOn: accounts.dateCloture ?? null,
      kind: accounts.typeBilan ?? null,
      confidentiality: accounts.confidentiality ?? null,
    })),
  };
}

const refusedProspecting = (formality: CompanyAnswer["formality"]) =>
  String(formality?.diffusionCommerciale).toLowerCase() === "false" || formality?.diffusionINSEE === "N" || formality?.diffusionINSEE === "P";

/**
 * What the register says about a company. When it refused commercial use of its data, its directors
 * are left out altogether: nothing downstream can write to them by mistake, and the opt-out is said.
 */
function companyFacts(siren: string, answer: CompanyAnswer, attachments: Attachments | null): CompanyFacts {
  const content = answer.formality?.content;
  const registrant = content?.personneMorale ?? content?.personnePhysique ?? content?.exploitation;
  const identity = registrant?.identite?.entreprise;
  const address = registrant?.adresseEntreprise?.adresse;
  const registryOptOut = refusedProspecting(answer.formality);
  const directors = directorsOf(registrant);
  const soleTrader = content?.personnePhysique ? directors[0] : undefined;
  return {
    siren,
    name: identity?.denomination ?? (soleTrader && !registryOptOut ? [soleTrader.firstName, soleTrader.lastName].filter(Boolean).join(" ") : siren),
    facts: {
      registryOptOut,
      legalForm: identity?.formeJuridique ?? content?.natureCreation?.formeJuridique ?? null,
      activity: identity?.codeApe ?? null,
      registeredOn: identity?.dateImmat ?? null,
      headOffice: address ? { street: [address.numVoie, address.typeVoie, address.voie].filter(Boolean).join(" ") || null, postcode: address.codePostal ?? null, city: address.commune ?? null } : null,
      directors: registryOptOut ? [] : directors,
      filings: filingsOf(attachments),
    },
  };
}

/** Requests to the register, signed in once and again if the token has expired. */
function sessionOf({ fetch: fetchUrl, fields }: AdapterContext) {
  let token: string | undefined;
  const logIn = async () => {
    const body = JSON.stringify({ username: fields.username, password: fields.password });
    const answer = await requestJson<{ token: string; user?: { email?: string } }>(fetchUrl, PROVIDER, `${API}/sso/login`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
    token = answer.token;
    return answer;
  };
  const request = async <T>(path: string) => requestJson<T>(fetchUrl, PROVIDER, `${API}${path}`, { headers: bearerJson(token ?? (await logIn()).token) });
  const get = async <T>(path: string): Promise<T> => {
    try {
      return await request<T>(path);
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 401)) throw error;
      token = undefined;
      return request<T>(path);
    }
  };
  return { logIn, get };
}

export const inpi: Adapter = (context) => {
  const { logIn, get } = sessionOf(context);
  return {
    check: () =>
      checked(PROVIDER, async () => {
        const email = (await logIn()).user?.email ?? context.fields.username;
        return { ok: true, detail: `Compte INPI ${email}`, label: email };
      }),

    company: async (siren) => {
      const path = `/companies/${encodeURIComponent(siren)}`;
      const answer = await nullWhenNotFound(() => get<CompanyAnswer>(path));
      if (!answer) return null;
      return companyFacts(siren, answer, await nullWhenNotFound(() => get<Attachments>(`${path}/attachments`)));
    },
  };
};
