import { createHmac } from "node:crypto";
import { ProviderError } from "./http";

/** What adapters need to trust and read what a service posts to Coldlyne. */

export const hmac = (algorithm: "sha1" | "sha256" | "sha512", key: string, payload: string, encoding: "hex" | "base64" | "base64url") => createHmac(algorithm, key).update(payload, "utf8").digest(encoding);

export { sameSecret } from "../crypto/secrets";

export const forgedWebhook = (provider: string) => new ProviderError(provider, 401, `Message non lu\u00A0: rien ne prouve qu’il a été envoyé par ${provider}.`);

/** The JSON a service posted; throws when it can't be read, so the service knows to send it again. */
export function parseWebhook<T extends object>(provider: string, body: string): T {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) return parsed as T;
  } catch {
    // Said below, as for JSON that isn't an object.
  }
  throw new ProviderError(provider, 400, `${provider} a envoyé un message illisible.`);
}

/** A date from Unix seconds, in a number or a string; this one when the service gave none. */
export function unixDate(seconds: number | string | null | undefined, fallback: Date): Date {
  const at = new Date(Number(seconds) * 1000);
  return seconds && !Number.isNaN(at.getTime()) ? at : fallback;
}
