import type { InboundRequest } from "@/application/ports";
import { forgedWebhook, hmac, sameSecret } from "../webhooks";

/**
 * Twilio's signature on what it posts, per https://www.twilio.com/docs/usage/security: the full
 * URL, then each POST parameter's name and value in the case-sensitive order of their names, with
 * no delimiter, as HMAC-SHA1 in Base64, keyed with the auth token. Repeated names as in
 * https://github.com/twilio/twilio-node/blob/main/src/webhooks/webhooks.ts: distinct values, sorted.
 */
export function twilioSignature(url: string, params: URLSearchParams, authToken: string): string {
  const parameters = [...new Set(params.keys())].sort().flatMap((name) => [...new Set(params.getAll(name))].sort().map((value) => name + value));
  return hmac("sha1", authToken, url + parameters.join(""), "base64");
}

/** Twilio signs an HTTPS voice callback without its port, though the address received may have one. */
const withoutPort = (url: string) => url.replace(/^(https?:\/\/[^/:?#]+):\d+/, "$1");

/** Throws unless Twilio signed this request, with the address exactly as it was requested. */
export function assertFromTwilio(request: InboundRequest, params: URLSearchParams, authToken: string): void {
  const given = request.headers.get("x-twilio-signature") ?? "";
  const signedByTwilio = [request.url, withoutPort(request.url)].some((url) => sameSecret(given, twilioSignature(url, params, authToken)));
  if (!signedByTwilio) throw forgedWebhook("Twilio");
}
