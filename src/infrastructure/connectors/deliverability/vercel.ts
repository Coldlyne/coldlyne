import type { DnsRecord } from "@/application/ports";
import { domainAndParents, sameRecord } from "@/domain/deliverability";
import type { Adapter, AdapterContext } from "../adapter";
import { checked } from "../checked";
import { bearerJson, ProviderError, requestJson } from "../http";
import { everyPage } from "../pages";
import { fullName, mxValue, parseMxValue, relativeName, unquotedTxt, type StoredRecord } from "./names";

/**
 * Vercel DNS, through its REST API: a bearer token, and `teamId` when the domain is a team's.
 *
 * Docs:
 * - https://vercel.com/docs/rest-api/dns/list-existing-dns-records
 * - https://vercel.com/docs/rest-api/dns/create-a-dns-record
 * - https://vercel.com/docs/rest-api/dns/update-an-existing-dns-record
 * - https://vercel.com/docs/rest-api/domains/list-all-the-domains
 * - https://vercel.com/docs/rest-api/user/get-the-user
 * - https://vercel.com/docs/rest-api/reference (pagination: `until`, 100 a page at most)
 */

const PROVIDER = "Vercel";
const API = "https://api.vercel.com";
const PAGE_SIZE = "100";
/** Vercel's default is 60 seconds; Microsoft's SPF guide asks for an hour at least, and these rarely change. */
const TTL_SECONDS = 3600;

interface VercelRecord {
  id: string;
  /** Relative to the zone; empty for its apex. */
  name: string;
  type: string;
  value: string;
  mxPriority?: number;
}

interface Pagination {
  pagination?: { next?: number | null };
}

interface RecordsPage extends Pagination {
  records?: VercelRecord[];
}

interface DomainsPage extends Pagination {
  domains?: unknown[];
}

interface VercelUser {
  user?: { email?: string; name?: string | null; username?: string };
}

/** Vercel's own example writes the priority inside an MX's value too, so don't assume a bare host. */
const mxOf = ({ value, mxPriority }: VercelRecord) => (/^\d+\s/.test(value.trim()) ? value.trim() : mxValue(mxPriority, value));

/** A record in the port's form, on this domain; null for what lies outside it or the port doesn't deal in. */
function stored(raw: VercelRecord, zone: string, domain: string): StoredRecord | null {
  const name = relativeName(fullName(raw.name, zone), domain);
  if (name === null) return null;
  if (raw.type === "TXT") return { id: raw.id, record: { type: "TXT", name, value: unquotedTxt(raw.value) } };
  if (raw.type === "CNAME") return { id: raw.id, record: { type: "CNAME", name, value: raw.value } };
  return raw.type === "MX" ? { id: raw.id, record: { type: "MX", name, value: mxOf(raw) } } : null;
}

function vercelUrl(context: AdapterContext, path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...params, ...(context.fields.teamId ? { teamId: context.fields.teamId } : {}) }).toString();
  return `${API}${path}${query ? `?${query}` : ""}`;
}

/** Vercel knows a domain by its registered name, so a subdomain's records are its parent's. */
async function zoneRecords(context: AdapterContext, domain: string): Promise<{ zone: string; records: VercelRecord[] }> {
  let refusal: unknown;
  for (const zone of domainAndParents(domain)) {
    try {
      return { zone, records: await listRecords(context, zone) };
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
      refusal = error;
    }
  }
  throw refusal;
}

async function listRecords(context: AdapterContext, zone: string): Promise<VercelRecord[]> {
  const headers = bearerJson(context.fields.token);
  const pages = await everyPage(
    (until) => requestJson<RecordsPage>(context.fetch, PROVIDER, vercelUrl(context, `/v5/domains/${encodeURIComponent(zone)}/records`, { limit: PAGE_SIZE, ...(until ? { until } : {}) }), { headers }),
    (page) => page.pagination?.next,
  );
  return pages.flatMap((page) => page.records ?? []);
}

async function countDomains(context: AdapterContext): Promise<number> {
  const headers = bearerJson(context.fields.token);
  const pages = await everyPage(
    (until) => requestJson<DomainsPage>(context.fetch, PROVIDER, vercelUrl(context, "/v5/domains", { limit: PAGE_SIZE, ...(until ? { until } : {}) }), { headers }),
    (page) => page.pagination?.next,
  );
  return pages.reduce((count, page) => count + (page.domains?.length ?? 0), 0);
}

/** What the API wants for a record's value: an MX's host and priority go apart. */
function writableValue(record: DnsRecord): { value: string; mxPriority?: number } {
  if (record.type !== "MX") return { value: record.value };
  const { priority, host } = parseMxValue(record.value);
  return { value: host, mxPriority: priority };
}

export const vercelDns: Adapter = (context) => {
  const headers = bearerJson(context.fields.token);

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const { user } = await requestJson<VercelUser>(context.fetch, PROVIDER, `${API}/v2/user`, { headers });
        const count = await countDomains(context);
        return { ok: true, detail: count > 1 ? `${count} domaines` : `${count} domaine`, label: user?.email ?? user?.username ?? user?.name ?? undefined };
      }),

    async records(domain: string): Promise<DnsRecord[]> {
      const { zone, records } = await zoneRecords(context, domain);
      return records.flatMap((raw) => stored(raw, zone, domain)?.record ?? []);
    },

    async upsertRecord(domain: string, record: DnsRecord): Promise<void> {
      const { zone, records } = await zoneRecords(context, domain);
      const existing = records.flatMap((raw) => stored(raw, zone, domain) ?? []).find((candidate) => sameRecord(candidate.record, record));
      if (existing?.record.value === record.value) return;
      const write = writableValue(record);
      if (existing) {
        await requestJson(context.fetch, PROVIDER, vercelUrl(context, `/v1/domains/records/${existing.id}`), { method: "PATCH", headers, body: JSON.stringify(write) });
        return;
      }
      const name = relativeName(fullName(record.name, domain), zone);
      await requestJson(context.fetch, PROVIDER, vercelUrl(context, `/v2/domains/${encodeURIComponent(zone)}/records`), {
        method: "POST",
        headers,
        body: JSON.stringify({ name: name === "@" ? "" : name, type: record.type, ttl: TTL_SECONDS, ...write }),
      });
    },
  };
};
