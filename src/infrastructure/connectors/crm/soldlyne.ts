import { z } from "zod";
import type { Channel, CrmContact } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { isInternalHost } from "../hosts";
import { bearerJson, ProviderError, requestJson } from "../http";
import { checkAccount, jsonInit, known } from "./push";

/**
 * Soldlyne, Coldlyne's sister CRM, on the address of the member's install: it gets who replies as a
 * company, a person and a deal, and says who its customers and open deals are. The key is of its
 * own kind there, made for this, and can do no more than that. Nothing here reaches anyone but Soldlyne.
 *
 * Docs: https://github.com/Soldlyne/soldlyne#connecting-coldlyne
 */

const PROVIDER = "Soldlyne";
const PAGE = 200;
/** A guard against an address that never stops answering: at this size, 200,000 deals. */
const MOST_PAGES = 1000;
const NOT_FOR_COLDLYNE = "Cette clé ne peut que lire : dans Soldlyne, créez une clé pour Coldlyne, sous Settings → API keys.";
/** From this version on, Soldlyne keeps deleted people deleted. An older install would restore them. */
const HANDOVER_VERSION = 2;
const TOO_OLD = "Cette installation de Soldlyne est trop ancienne : mettez-la à jour avant de la relier, sinon elle ferait revenir les personnes que vous y avez supprimées.";
/** What Soldlyne answers, with a 409, about someone deleted there. Its other 409s are trouble to report: a product gone, no open stage. */
const PERSON_DELETED = "person_deleted";

const SOURCE: Record<Channel, string> = { email: "EMAIL", sms: "PHONE", call: "PHONE", voicemail: "PHONE", whatsapp: "PHONE", linkedin: "LINKEDIN", instagram: "SOCIAL", messenger: "SOCIAL", x: "SOCIAL", letter: "OTHER" };

/** Comes from another server: read rather than trusted, since it lands on a list that stops sending. */
const offLimitsPage = z.object({
  data: z.array(
    z.object({
      company: z.object({ name: z.string(), domain: z.string().nullable(), siren: z.string().nullable() }).nullable(),
      people: z.array(z.object({ emails: z.array(z.string()), phones: z.array(z.string()), linkedinUrl: z.string().nullable() })),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/** The member types the address and the key goes wherever it points: never to Coldlyne's own network, never in clear. */
function originOf(address: string | undefined): string {
  const url = address && URL.canParse(address) ? new URL(address) : null;
  if (url?.protocol !== "https:" || isInternalHost(url.hostname)) throw new ProviderError(PROVIDER, 400, "L’adresse de Soldlyne doit être une adresse https publique, comme https://app.soldlyne.com.");
  return url.origin;
}

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** A redirect could carry the key to another host, so it's refused rather than followed. */
const caller =
  ({ fields, fetch }: AdapterContext): Call =>
  <T>(path: string, method = "GET", body?: unknown) =>
    requestJson<T>(fetch, PROVIDER, `${originOf(fields.address)}${path}`, { ...jsonInit(method, bearerJson(fields.apiKey), body), redirect: "error" });

/** What Soldlyne is handed, cut to what it takes: one long name shouldn't cost someone their deal. */
const handover = ({ firstName, lastName, email, phone, role, company, note, channel }: CrmContact) =>
  known({
    company: known({ name: company.name.slice(0, 200), website: company.website?.slice(0, 300), siren: company.siren }),
    person: known({ firstName: firstName?.slice(0, 100), lastName: lastName.slice(0, 100), email, phone: phone?.slice(0, 50), jobTitle: role?.slice(0, 200) }),
    note,
    source: channel ? SOURCE[channel] : "OTHER",
  });

async function readAllOffLimits(call: Call) {
  const entries: z.output<typeof offLimitsPage>["data"] = [];
  let cursor = "";
  for (let page = 0; page < MOST_PAGES; page++) {
    const { data, nextCursor } = offLimitsPage.parse(await call(`/api/v1/do-not-prospect?limit=${PAGE}${cursor && `&cursor=${encodeURIComponent(cursor)}`}`));
    entries.push(...data);
    if (!nextCursor) return entries;
    cursor = nextCursor;
  }
  throw new ProviderError(PROVIDER, 502, "La liste de Soldlyne ne finit pas.");
}

/** Refuses an install that would restore people. And a read key would connect and then fail at the first reply: this asks for the one thing a read key can't. */
async function workspaceNamed(call: Call): Promise<string> {
  const { name, handoverVersion } = await call<{ name: string; handoverVersion?: number }>("/api/v1/workspace");
  if (!handoverVersion || handoverVersion < HANDOVER_VERSION) throw new ProviderError(PROVIDER, 400, TOO_OLD);
  try {
    await call(`/api/v1/do-not-prospect?limit=1`);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 403) throw new ProviderError(PROVIDER, 403, NOT_FOR_COLDLYNE);
    throw error;
  }
  return name;
}

/** The deal they're on, or no id for someone deleted there, who stays deleted and is left alone. */
async function handOver(call: Call, contact: CrmContact): Promise<{ externalId: string | null }> {
  try {
    return { externalId: (await call<{ dealId: string }>("/api/v1/handovers", "POST", handover(contact))).dealId };
  } catch (error) {
    if (error instanceof ProviderError && error.status === 409 && error.message.includes(PERSON_DELETED)) return { externalId: null };
    throw error;
  }
}

export const soldlyne: Adapter = (context) => {
  const call = caller(context);
  return {
    check: () => checkAccount(() => workspaceNamed(call)),
    pushContact: (contact) => handOver(call, contact),
    offLimits: () => readAllOffLimits(call),
  };
};
