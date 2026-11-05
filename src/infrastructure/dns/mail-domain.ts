import dns from "node:dns/promises";
import type { DnsResolver } from "./checks";

const NO_SUCH = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * Whether a domain can receive mail at all, before writing to it costs a bounce. A DNS that doesn't
 * answer proves nothing, so it counts as yes: only a definite no keeps a message from leaving.
 */
export async function acceptsMail(domain: string, resolver: Pick<DnsResolver, "resolveMx"> = dns): Promise<boolean> {
  try {
    const records = await resolver.resolveMx(domain);
    // A null MX (RFC 7505) has an empty exchange: the domain says it takes no mail.
    return records.some(({ exchange }) => exchange.replace(/\.$/, "") !== "");
  } catch (error) {
    return !NO_SUCH.has((error as NodeJS.ErrnoException).code ?? "");
  }
}
