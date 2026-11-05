import type { DnsRecord } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { ProviderError } from "../http";
import { type OvhClient, ovhClient, readEach, segment } from "../ovh";

/**
 * OVHcloud DNS: SPF, DKIM and DMARC records on a sending domain whose zone OVH hosts. The sending
 * domain may be a subdomain of the zone (mail.acme.fr in acme.fr), so names are moved between
 * the domain and the zone; a change is only served once the zone is refreshed.
 *
 * Docs: https://eu.api.ovh.com/1.0/domain.json
 *       https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-records
 *       https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-spf
 *       https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-dmarc
 *       https://github.com/ovh/terraform-provider-ovh/blob/master/ovh/resource_domain_zone_record.go (quoting, apex)
 */

const PROVIDER = "OVHcloud";

interface OvhRecord {
  id: number;
  zone: string;
  subDomain?: string | null;
  fieldType: string;
  target: string;
}

/**
 * OVH's record types behind each of the port's. Its console writes SPF, DKIM and DMARC under types
 * of their own, served as TXT: looking at TXT alone would miss them and add a second SPF record,
 * which breaks SPF altogether.
 */
const OVH_TYPES: Record<DnsRecord["type"], readonly string[]> = {
  TXT: ["TXT", "SPF", "DKIM", "DMARC"],
  CNAME: ["CNAME"],
  MX: ["MX"],
};

const portTypeOf = (fieldType: string) => (Object.keys(OVH_TYPES) as DnsRecord["type"][]).find((type) => OVH_TYPES[type].includes(fieldType));

/** Where a domain sits in the account: its zone, and the domain's own part of it ("" at the apex, "mail" for mail.acme.fr). */
interface Placement {
  zone: string;
  prefix: string;
}

export const ovhDns: Adapter = (context) => {
  const ovh = ovhClient(context);
  return {
    check: () =>
      checked(PROVIDER, async () => {
        const zones = await ovh.call<string[]>("GET", "/domain/zone");
        if (!zones.length) return { ok: false, detail: "Ce compte OVHcloud n’héberge aucune zone DNS." };
        return { ok: true, label: zonesLabel(zones), detail: `${zones.length} zone${zones.length > 1 ? "s" : ""} DNS` };
      }),
    async records(domain) {
      const placement = await placementOf(ovh, domain);
      const types = Object.values(OVH_TYPES).flat();
      const records = await Promise.all(types.map((type) => recordsOf(ovh, placement.zone, type)));
      return records.flat().flatMap((record) => toDnsRecord(record, placement));
    },
    async upsertRecord(domain, record) {
      const placement = await placementOf(ovh, domain);
      const zonePath = `/domain/zone/${segment(placement.zone)}`;
      const subDomain = subDomainOf(record.name, placement);
      const existing = (await Promise.all(OVH_TYPES[record.type].map((type) => recordsOf(ovh, placement.zone, type, subDomain)))).flat();
      const replaced = existing.find((candidate) => replaces(record, toDnsRecord(candidate, placement)[0]));
      const target = targetOf(record);
      // PUT can't change a record's type or need its name; an apex record has no subDomain to send.
      if (replaced) await ovh.call("PUT", `${zonePath}/record/${replaced.id}`, { target });
      else await ovh.call("POST", `${zonePath}/record`, { fieldType: record.type, ...(subDomain ? { subDomain } : {}), target });
      await ovh.call("POST", `${zonePath}/refresh`);
    },
  };
};

/** The account's first zones, to name the connection. */
const zonesLabel = (zones: string[]) => `${zones.slice(0, 3).join(", ")}${zones.length > 3 ? "…" : ""}`;

/** The zone holding the domain: itself, or the closest parent the account hosts. */
async function placementOf(ovh: OvhClient, domain: string): Promise<Placement> {
  const wanted = domain.toLowerCase().replace(/\.$/, "");
  const zones = await ovh.call<string[]>("GET", "/domain/zone");
  const zone = zones
    .map((candidate) => candidate.toLowerCase())
    .filter((candidate) => wanted === candidate || wanted.endsWith(`.${candidate}`))
    .sort((a, b) => b.length - a.length)[0];
  if (!zone) throw new ProviderError(PROVIDER, 404, `Aucune zone DNS de ce compte OVHcloud ne contient ${wanted}.`);
  return { zone, prefix: wanted === zone ? "" : wanted.slice(0, -zone.length - 1) };
}

/**
 * The zone's records of a type, each read in full (the list only gives their ids). An apex name
 * isn't asked for, since OVH's filter on an empty name is undocumented; `replaces` sorts them out.
 */
async function recordsOf(ovh: OvhClient, zone: string, fieldType: string, subDomain?: string): Promise<OvhRecord[]> {
  const query = new URLSearchParams({ fieldType, ...(subDomain ? { subDomain } : {}) });
  const ids = await ovh.call<number[]>("GET", `/domain/zone/${segment(zone)}/record?${query}`);
  return readEach(ids, (id) => ovh.call<OvhRecord>("GET", `/domain/zone/${segment(zone)}/record/${id}`));
}

/** A record's name in the zone, from its name relative to the domain ("@", "_dmarc"). */
function subDomainOf(name: string, { prefix }: Placement): string {
  const relative = name === "@" ? "" : name;
  return [relative, prefix].filter(Boolean).join(".");
}

/** The zone's record as the port names it, or nothing when it lies outside the domain. */
function toDnsRecord(record: OvhRecord, placement: Placement): DnsRecord[] {
  const type = portTypeOf(record.fieldType);
  const name = nameOf(record.subDomain ?? "", placement);
  return type && name !== null ? [{ type, name, value: valueOf(record, type) }] : [];
}

/** A record's name relative to the domain, from its name in the zone; null when outside the domain. */
function nameOf(subDomain: string, { prefix }: Placement): string | null {
  if (!prefix) return subDomain || "@";
  if (subDomain === prefix) return "@";
  return subDomain.endsWith(`.${prefix}`) ? subDomain.slice(0, -prefix.length - 1) : null;
}

/** OVH quotes TXT values, splitting long ones ("a" "b"), and ends hosts with a dot; the port does neither. */
function valueOf(record: OvhRecord, type: DnsRecord["type"]): string {
  if (type !== "TXT") return record.target.replace(/\.$/, "");
  return record.target.replace(/"\s+"/g, "").replace(/^"([\s\S]*)"$/, "$1");
}

/**
 * What OVH is sent: a TXT unquoted, as it adds the quotes itself. A host gets a final dot, without
 * which a zone file reads it as relative to the zone (acme.fr's `a.net` meaning `a.net.acme.fr`).
 */
function targetOf(record: DnsRecord): string {
  if (record.type === "TXT" || record.value.endsWith(".")) return record.value;
  return `${record.value}.`;
}

/**
 * Whether a record replaces this one. Several TXT records share a name (SPF beside a site's
 * verification token), so a TXT only replaces one with the same value or the same `v=` tag
 * (v=spf1, v=DMARC1, v=DKIM1): an SPF update never wipes a verification token.
 */
function replaces(wanted: DnsRecord, existing: DnsRecord | undefined): boolean {
  if (!existing || existing.type !== wanted.type || existing.name.toLowerCase() !== wanted.name.toLowerCase()) return false;
  if (wanted.type !== "TXT") return true;
  const tag = txtTag(wanted.value);
  return existing.value === wanted.value || (tag !== null && tag === txtTag(existing.value));
}

const txtTag = (value: string) => /^v=([a-z0-9]+)/i.exec(value.trim())?.[1].toLowerCase() ?? null;
