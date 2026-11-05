import type { InboundRequest, Signal } from "@/application/ports";
import { sha256 } from "@/infrastructure/crypto/secrets";
import type { Adapter, AdapterContext } from "../adapter";

/**
 * Sign-ups from the business's own site: its form (or its back end) posts each one to the
 * connection's address, and Coldlyne credits it to the message that brought the person. The route
 * has already checked the address's token, so anything posted here is the site's.
 *
 * Coldlyne's own format, documented for sites at https://coldlyne.com/docs/inscriptions:
 *   JSON { "email": "...", "at"?: ISO date, "id"?: string }, or a form-encoded `email=`.
 */

/** What a site posts, before it is checked. */
interface Posted {
  email?: unknown;
  at?: unknown;
  id?: unknown;
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const isJson = (request: InboundRequest) => {
  const type = request.headers.get("content-type") ?? "";
  return type.includes("json") || (!type && request.body.trimStart().startsWith("{"));
};

/** The posted fields, from a JSON body or a form. */
function postedIn(request: InboundRequest): Posted {
  if (!isJson(request)) return Object.fromEntries(new URLSearchParams(request.body));
  try {
    const json: unknown = JSON.parse(request.body);
    if (json && typeof json === "object" && !Array.isArray(json)) return json as Posted;
  } catch {
    // Said below, in the site's words.
  }
  throw new Error("Le corps de la demande n’est pas un objet JSON lisible.");
}

function emailIn(posted: Posted): string {
  const email = typeof posted.email === "string" ? posted.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) throw new Error("L’adresse email de l’inscription manque ou n’est pas valide.");
  return email;
}

function dateIn(posted: Posted, now: Date): Date {
  if (posted.at === undefined || posted.at === "") return now;
  const at = typeof posted.at === "string" ? new Date(posted.at) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new Error("La date de l’inscription (at) n’est pas une date ISO 8601.");
  return at;
}

/**
 * The site's own id for the sign-up, or one made from the address and the day, so a form posted
 * twice the same day counts once.
 */
function idOf(posted: Posted, email: string, at: Date): string {
  if ((typeof posted.id === "string" && posted.id.trim()) || typeof posted.id === "number") return String(posted.id).trim();
  return sha256(`${email}:${at.toISOString().slice(0, 10)}`);
}

/** One `signed_up` signal from what the site posted; throws on a missing or invalid address. */
function signupIn(request: InboundRequest, now: Date): Signal {
  if (request.method.toUpperCase() !== "POST") throw new Error("Les inscriptions s’envoient en POST.");
  const posted = postedIn(request);
  const email = emailIn(posted);
  const at = dateIn(posted, now);
  return { type: "signed_up", channel: "site", externalId: idOf(posted, email, at), address: email, at };
}

const ready = async () => ({ ok: true, detail: "Prêt à recevoir les inscriptions de votre site.", label: "Inscriptions" });

export const signups: Adapter = (context: AdapterContext) => ({
  check: ready,
  readWebhook: async (request) => ({ signals: [signupIn(request, context.now())] }),
});
