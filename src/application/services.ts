import type { Database } from "@/infrastructure/db/client";
import type { DnsResolver } from "@/infrastructure/dns/checks";
import type { Env } from "@/infrastructure/env";

/** What the use cases that reach outside Coldlyne run with: the database, the instance's settings, the network and the clock. */
export interface Services {
  db: Database;
  settings: Env;
  fetch: typeof fetch;
  now: () => Date;
  /** Public DNS, unless a test answers instead. */
  dns?: DnsResolver;
}
