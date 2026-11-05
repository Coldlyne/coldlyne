import type { DnsRecord } from "@/application/ports";
import { hostnameOf } from "@/domain/deliverability";

/**
 * Going between the port's records (names relative to the domain, an MX as one value) and what DNS
 * providers want. A sending domain may be a subdomain of the zone it lives in, so names are always
 * worked out through the full name.
 */

/** A record as the provider holds it: the port's form, and the id it takes to update it. */
export interface StoredRecord {
  id: string;
  record: DnsRecord;
}

/** "_dmarc" on "acme.fr" → "_dmarc.acme.fr"; "@" or nothing is the domain itself. */
export const fullName = (name: string, domain: string) => (!name || name === "@" ? hostnameOf(domain) : hostnameOf(`${name}.${domain}`));

/** A full name relative to a domain ("@" for the domain itself); null when it lies outside it. */
export function relativeName(full: string, domain: string): string | null {
  const [name, parent] = [hostnameOf(full), hostnameOf(domain)];
  if (name === parent) return "@";
  return name.endsWith(`.${parent}`) ? name.slice(0, -parent.length - 1) : null;
}

/** The port's DnsRecord has no priority, so an MX's value carries it, as a zone file writes it. */
export const mxValue = (priority: number | undefined, host: string) => `${priority ?? DEFAULT_MX_PRIORITY} ${hostnameOf(host)}`;

const DEFAULT_MX_PRIORITY = 10;

/** "10 mx1.mail.ovh.net." → its parts; a bare host gets the usual priority. */
export function parseMxValue(value: string): { priority: number; host: string } {
  const [first, second] = value.trim().split(/\s+/);
  return second ? { priority: Number(first), host: hostnameOf(second) } : { priority: DEFAULT_MX_PRIORITY, host: hostnameOf(first) };
}

/** A TXT as DNS writes it, in quoted strings ("v=spf1 " "~all"), back to the text it stands for. */
export function unquotedTxt(content: string): string {
  const strings = content.match(/"(?:[^"\\]|\\.)*"/g);
  return strings ? strings.map((string) => string.slice(1, -1).replace(/\\(["\\])/g, "$1")).join("") : content;
}

/** A TXT as one quoted string; the provider splits what is too long for DNS's 255 bytes. */
export const quotedTxt = (text: string) => `"${text.replace(/(["\\])/g, "\\$1")}"`;
