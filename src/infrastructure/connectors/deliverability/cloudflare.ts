import type { DnsRecord } from "@/application/ports";
import { domainAndParents, sameRecord } from "@/domain/deliverability";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, ProviderError, requestJson } from "../http";
import { everyPage } from "../pages";
import { fullName, mxValue, parseMxValue, quotedTxt, relativeName, unquotedTxt, type StoredRecord } from "./names";

/**
 * Cloudflare DNS, through API v4: find the zone by name, then list, create or update its records.
 *
 * An account-owned token can't be verified at /user/tokens/verify: its own endpoint needs an account
 * id the connection doesn't have. So a 401 there isn't the last word: listing zones settles it,
 * which also shows whether the token can see the zone it will have to change.
 *
 * Docs:
 * - https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/
 * - https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/
 * - https://developers.cloudflare.com/api/resources/zones/methods/list/
 * - https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/
 * - https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
 * - https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/
 */

const PROVIDER = "Cloudflare";
const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = "100";
/** Cloudflare's "automatic". */
const AUTOMATIC_TTL = 1;
/** The API refuses fewer than 5 zones a page. */
const ZONES_PER_PAGE = "5";

interface CloudflareRecord {
  id: string;
  /** The full name, zone included. */
  name: string;
  type: string;
  content: string;
  priority?: number;
}

interface RecordsPage {
  result?: CloudflareRecord[];
  result_info?: { page?: number; total_pages?: number };
}

interface ZonesPage {
  result?: { id: string; name: string; account?: { name?: string } }[];
  result_info?: { total_count?: number };
}

/** A record in the port's form, on this domain; null for what lies outside it or the port doesn't deal in. */
function stored(raw: CloudflareRecord, domain: string): StoredRecord | null {
  const name = relativeName(raw.name, domain);
  if (name === null) return null;
  if (raw.type === "TXT") return { id: raw.id, record: { type: "TXT", name, value: unquotedTxt(raw.content) } };
  if (raw.type === "CNAME") return { id: raw.id, record: { type: "CNAME", name, value: raw.content } };
  return raw.type === "MX" ? { id: raw.id, record: { type: "MX", name, value: mxValue(raw.priority, raw.content) } } : null;
}

/** The body for a create or an update, the same for both since the API doesn't mark name and type optional. */
function writable(record: DnsRecord, domain: string) {
  const common = { type: record.type, name: fullName(record.name, domain), ttl: AUTOMATIC_TTL };
  if (record.type === "TXT") return { ...common, content: quotedTxt(record.value) };
  // Proxied, a DKIM CNAME would answer with Cloudflare's addresses instead of its target.
  if (record.type === "CNAME") return { ...common, content: record.value, proxied: false };
  const { priority, host } = parseMxValue(record.value);
  return { ...common, content: host, priority };
}

export const cloudflareDns: Adapter = (context) => {
  const headers = bearerJson(context.fields.apiToken);
  const get = <T>(path: string) => requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, { headers });

  /** The token's status, or null when this endpoint can't tell: see the top of this file. */
  async function tokenStatus(): Promise<string | null> {
    try {
      return (await get<{ result?: { status?: string } }>("/user/tokens/verify")).result?.status ?? null;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 401) return null;
      throw error;
    }
  }

  /** The zone a domain lives in: its own, or a parent's for a sending subdomain. */
  async function zoneOf(domain: string): Promise<string> {
    for (const name of domainAndParents(domain)) {
      const { result } = await get<ZonesPage>(`/zones?${new URLSearchParams({ name, per_page: ZONES_PER_PAGE })}`);
      if (result?.length) return result[0].id;
    }
    throw new ProviderError(PROVIDER, 404, `Cloudflare ne trouve pas de zone pour ${domain} : vérifiez que ce jeton peut la lire.`);
  }

  async function zoneRecords(zoneId: string): Promise<CloudflareRecord[]> {
    const pages = await everyPage(
      (page) => get<RecordsPage>(`/zones/${zoneId}/dns_records?${new URLSearchParams({ per_page: PAGE_SIZE, page: page ?? "1" })}`),
      ({ result_info }) => ((result_info?.page ?? 1) < (result_info?.total_pages ?? 1) ? (result_info?.page ?? 1) + 1 : null),
    );
    return pages.flatMap((page) => page.result ?? []);
  }

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const status = await tokenStatus();
        if (status && status !== "active") return { ok: false, detail: "Ce jeton Cloudflare n’est plus actif : créez-en un autre." };
        const { result, result_info } = await get<ZonesPage>(`/zones?per_page=${ZONES_PER_PAGE}`);
        const count = result_info?.total_count ?? result?.length ?? 0;
        if (!count) return { ok: false, detail: "Ce jeton ne voit aucune zone : donnez-lui les droits Zone (lire) et DNS (modifier) sur votre domaine d’envoi." };
        return { ok: true, detail: count > 1 ? `${count} zones` : "1 zone", label: result?.[0]?.account?.name ?? result?.[0]?.name };
      }),

    async records(domain: string): Promise<DnsRecord[]> {
      const records = await zoneRecords(await zoneOf(domain));
      return records.flatMap((raw) => stored(raw, domain)?.record ?? []);
    },

    async upsertRecord(domain: string, record: DnsRecord): Promise<void> {
      const zoneId = await zoneOf(domain);
      const records = await zoneRecords(zoneId);
      const existing = records.flatMap((raw) => stored(raw, domain) ?? []).find((candidate) => sameRecord(candidate.record, record));
      if (existing?.record.value === record.value) return;
      const body = JSON.stringify(writable(record, domain));
      if (existing) await requestJson(context.fetch, PROVIDER, `${API}/zones/${zoneId}/dns_records/${existing.id}`, { method: "PATCH", headers, body });
      else await requestJson(context.fetch, PROVIDER, `${API}/zones/${zoneId}/dns_records`, { method: "POST", headers, body });
    },
  };
};
