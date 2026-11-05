import { createHash } from "node:crypto";
import type { AdapterContext } from "./adapter";
import { requestJson } from "./http";

/**
 * OVHcloud's API, shared by its SMS and DNS connectors. Every call is signed with the
 * application's secret and the consumer key, and timestamped on OVH's clock rather than ours: OVH
 * refuses a signature whose timestamp drifts, so the difference is read once from `/auth/time`.
 *
 * Docs: https://docs.ovhcloud.com/en/guides/manage-and-operate/api/first-steps
 *       https://docs.ovhcloud.com/fr/guides/manage-and-operate/api/api-right-delegation
 *       https://github.com/ovh/node-ovh/blob/master/lib/ovh.es5.js (the official client's `signRequest`)
 *       https://eu.api.ovh.com/1.0/auth.json
 */

export const OVH_API = "https://eu.api.ovh.com/1.0";
const PROVIDER = "OVHcloud";
/** How many of a list's entries are read at once. */
const READS_AT_ONCE = 10;

export interface OvhCredentials {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

/** `$1$` and the SHA-1, in hex, of the secret, consumer key, method, full URL, body and timestamp joined by `+`. */
export function ovhSignature(credentials: OvhCredentials, method: string, url: string, body: string, timestamp: number): string {
  const signed = [credentials.applicationSecret, credentials.consumerKey, method, url, body, String(timestamp)].join("+");
  return `$1$${createHash("sha1").update(signed).digest("hex")}`;
}

function signedHeaders(credentials: OvhCredentials, method: string, url: string, body: string, timestamp: number): Record<string, string> {
  return {
    "x-ovh-application": credentials.applicationKey,
    "x-ovh-consumer": credentials.consumerKey,
    "x-ovh-timestamp": String(timestamp),
    "x-ovh-signature": ovhSignature(credentials, method, url, body, timestamp),
    "content-type": "application/json",
    accept: "application/json",
  };
}

/**
 * JSON in ASCII, accents written `é`. OVH checks the signature against the bytes it receives,
 * so a text with accents must not depend on how it gets encoded: the official client does the same.
 */
export const asciiJson = (body: unknown) => JSON.stringify(body).replace(/[\u0080-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

export interface OvhClient {
  /** A signed call to a path under `/1.0` (its query string included), and its JSON answer. */
  call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}

/** A client for the connection's OVH keys, which learns OVH's clock on its first call. */
export function ovhClient(context: AdapterContext): OvhClient {
  const { applicationKey, applicationSecret, consumerKey } = context.fields;
  const credentials = { applicationKey, applicationSecret, consumerKey };
  const seconds = () => Math.floor(context.now().getTime() / 1000);
  let drift: Promise<number> | undefined;
  const readDrift = () =>
    requestJson<number>(context.fetch, PROVIDER, `${OVH_API}/auth/time`).then(
      (serverTime) => serverTime - seconds(),
      (error: unknown) => {
        drift = undefined; // a failed read is tried again on the next call, not remembered
        throw error;
      },
    );

  return {
    async call<T>(method: string, path: string, body?: unknown) {
      const url = `${OVH_API}${path}`;
      const payload = body === undefined ? "" : asciiJson(body);
      const timestamp = seconds() + (await (drift ??= readDrift()));
      return requestJson<T>(context.fetch, PROVIDER, url, { method, headers: signedHeaders(credentials, method, url, payload, timestamp), body: payload || undefined });
    },
  };
}

/** A path segment from a member's value (a zone, an SMS account, a `+33…` number), so it can't reach another path. */
export const segment = (value: string) => encodeURIComponent(value);

/** OVH's lists only give ids, each read on its own: a few at a time, so a long list isn't a burst of calls. */
export async function readEach<Id, Entry>(ids: readonly Id[], read: (id: Id) => Promise<Entry>): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (let start = 0; start < ids.length; start += READS_AT_ONCE) {
    entries.push(...(await Promise.all(ids.slice(start, start + READS_AT_ONCE).map(read))));
  }
  return entries;
}
