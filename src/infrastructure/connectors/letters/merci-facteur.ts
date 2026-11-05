import { createHmac } from "node:crypto";
import type { Check, PostalAddress } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { balanceOf, checked } from "../checked";
import { ProviderError, requestJson } from "../http";
import { cachedToken } from "./token";

/**
 * Merci Facteur. A token comes from a signature of the service id and the time, then each letter
 * goes as a form whose address and content are JSON strings, the PDF in base64. It prints a PDF as
 * it is, with no colour setting, so a letter is black and white when its PDF is.
 *
 * Production only: no sandbox URL is published, Merci Facteur opens a "Sandbox" account on request.
 *
 * Docs: https://www.merci-facteur.com/api/1.2/doc.php (https://www.merci-facteur.com/api/1.2/openapi.json)
 *       https://github.com/MerciFacteur/Merci-facteur-API/blob/master/README.md
 *       https://github.com/MerciFacteur/Merci-facteur-API/tree/master/hash-secret-key
 *       https://github.com/MerciFacteur/Merci-facteur-API/blob/master/skills/mf-api-authentification/SKILL.md
 *       https://github.com/MerciFacteur/Merci-facteur-API/blob/master/skills/mf-envoi-courrier/SKILL.md
 */

const API = "https://www.merci-facteur.com/api/1.2/prod/service";
const PROVIDER = "Merci Facteur";
/** What the API asks for once the IP restriction is lifted, as a Vercel deployment has no fixed IP. */
const NO_IP_RESTRICTION = "111.111.111";
/** The postage of a green letter, its plain non-registered mail. */
const SIMPLE_LETTER = "normal";
const MISSING_USER = "Indiquez l’identifiant de l’utilisateur Merci Facteur au nom duquel partent les courriers (menu Utilisateurs).";

/** Every answer says `success`, which counts more than the HTTP status. */
interface MerciFacteurAnswer {
  success?: boolean;
  error?: string | { code?: string; text?: string };
}

interface TokenAnswer extends MerciFacteurAnswer {
  token: string;
  expire: number;
}

interface QuotaAnswer extends MerciFacteurAnswer {
  quotas?: { plan?: { name?: string }; credit?: { amount?: string | number; devise?: string } };
}

interface SendAnswer extends MerciFacteurAnswer {
  /** A list in the API's schema, a single id in its guide's sample. */
  envoi_id: number | number[];
  /** Strings in the API's schema, numbers in its guide's sample. */
  price?: { total?: { ttc?: string | number } };
}

/** HMAC-SHA256 of the service id and the time in seconds, in hex, valid five minutes. */
export function merciFacteurSignature(serviceId: string, secretKey: string, timestamp: number): string {
  return createHmac("sha256", secretKey).update(`${serviceId}${timestamp}`).digest("hex");
}

export const merciFacteur: Adapter = (context) => {
  const { serviceId, secretKey, userId } = context.fields;
  const token = cachedToken(context.now, async () => {
    const timestamp = Math.floor(context.now().getTime() / 1000);
    const headers = { "ww-service-signature": merciFacteurSignature(serviceId, secretKey, timestamp), "ww-timestamp": String(timestamp), "ww-service-id": serviceId, "ww-authorized-ip": NO_IP_RESTRICTION };
    const answer = await call<TokenAnswer>(context, "/getToken", { headers });
    return { token: answer.token, expiresAt: new Date(answer.expire * 1000) };
  });
  const signedHeaders = async () => ({ "ww-service-id": serviceId, "ww-access-token": await token() });

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { quotas } = await call<QuotaAnswer>(context, "/getQuotaCompte", { headers: await signedHeaders() });
        return checkOf(quotas, userId);
      }),
    async postLetter(letter) {
      if (!userId) throw new ProviderError(PROVIDER, 400, MISSING_USER);
      const body = new URLSearchParams({
        idUser: userId,
        modeEnvoi: SIMPLE_LETTER,
        adress: JSON.stringify({ exp: addressOf(letter.from), dest: [{ ...addressOf(letter.to), reference: letter.reference.replace(/[^A-Za-z0-9 _-]/g, "-").slice(0, 30) }] }),
        content: JSON.stringify({ letter: { files: "", base64files: [Buffer.from(letter.pdf).toString("base64")], print_sides: "recto" }, photo: "", card: "" }),
        designation: letter.reference.slice(0, 50),
        // Refused if seen again within 30 days, so a retry after a lost answer can't post it twice.
        antidoublon: letter.reference.slice(0, 200),
      });
      const headers = { ...(await signedHeaders()), "content-type": "application/x-www-form-urlencoded" };
      const sent = await call<SendAnswer>(context, "/sendCourrier", { method: "POST", headers, body });
      return { externalId: String(Array.isArray(sent.envoi_id) ? sent.envoi_id[0] : sent.envoi_id), ...costOf(sent) };
    },
  };
};

/** A call whose answer can say it failed even with a 2xx. */
async function call<Answer extends MerciFacteurAnswer>(context: AdapterContext, path: string, init: RequestInit): Promise<Answer> {
  const answer = await requestJson<Answer>(context.fetch, PROVIDER, `${API}${path}`, init);
  if (answer.success === false) throw new ProviderError(PROVIDER, 400, `Merci Facteur a refusé la demande : ${reasonOf(answer)}`);
  return answer;
}

const reasonOf = ({ error }: MerciFacteurAnswer) => (typeof error === "string" ? error : (error?.text ?? error?.code ?? "raison inconnue"));

/** The keys are accepted, but a letter can't leave without the user it is sent as: the check says so now. */
function checkOf(quotas: QuotaAnswer["quotas"], userId: string | undefined): Check {
  const label = quotas?.plan?.name;
  if (!userId) return { ok: false, label, detail: MISSING_USER };
  const { amount, devise } = quotas?.credit ?? {};
  const credit = Number(amount);
  return { ok: true, label, detail: amount === undefined || Number.isNaN(credit) ? "Compte actif" : balanceOf(credit, devise ?? "EUR") };
}

/** Every key must be there, `""` when unused, or the address is refused. A full name goes in `nom`. */
function addressOf(address: PostalAddress) {
  const [first = "", second = "", ...rest] = address.lines;
  return { civilite: "", nom: address.name, prenom: "", societe: address.company ?? "", adresse1: first, adresse2: second, adresse3: rest.join(" "), cp: address.postcode, ville: address.city, pays: "FRANCE" };
}

function costOf({ price }: SendAnswer): { cost?: number } {
  const cost = Number(String(price?.total?.ttc ?? "").replace(",", "."));
  return price?.total?.ttc === undefined || Number.isNaN(cost) ? {} : { cost };
}
