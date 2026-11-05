import type { Adapter } from "../adapter";
import { cloudflareDns } from "./cloudflare";
import { ovhDns } from "./ovh-dns";
import { postmaster } from "./postmaster";
import { vercelDns } from "./vercel";

/** The deliverability connectors, by kind. */
export const deliverabilityAdapters: Record<string, Adapter> = {
  postmaster,
  vercel_dns: vercelDns,
  cloudflare_dns: cloudflareDns,
  ovh_dns: ovhDns,
};
