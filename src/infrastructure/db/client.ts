import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import { keepParametersOutOfQueryErrors } from "./query-errors";
import * as auth from "./schema/auth";
import * as connections from "./schema/connections";
import * as prospects from "./schema/prospects";
import * as sequences from "./schema/sequences";
import * as tenancy from "./schema/tenancy";

/** Every area's tables, as Drizzle is told the database holds them. */
export const schema = { ...auth, ...tenancy, ...prospects, ...connections, ...sequences };

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export const DRIZZLE_CASING = "snake_case";

keepParametersOutOfQueryErrors();

export function connect(url: string): Database {
  // prepare: false keeps it compatible with transaction-mode poolers (Neon, PgBouncer).
  return drizzle(postgres(url, { prepare: false, max: 5 }), { schema, casing: DRIZZLE_CASING });
}

const globalForDb = globalThis as unknown as { coldlyneDb?: Database };

/** The shared connection; reused across hot reloads in development. */
export function db(): Database {
  globalForDb.coldlyneDb ??= connect(env().COLDLYNE_DATABASE_URL);
  return globalForDb.coldlyneDb;
}
