import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

type RunQuery = (queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>;

/** What a failed query's cause keeps, under each driver's name for it: all of it names the schema or a step in Postgres, never a value. */
const KEPT_FIELDS: Record<string, readonly string[]> = {
  code: ["code"],
  severity: ["severity"],
  constraint_name: ["constraint_name", "constraint"],
  table_name: ["table_name", "table"],
  column_name: ["column_name", "column"],
  routine: ["routine"],
};

/**
 * The SQLSTATE classes whose messages name the schema and never quote a value: connections, integrity,
 * transactions, sign-in, syntax and access, resources, and failures of Postgres or its host (XX is how
 * Neon says an endpoint is down). Any other class keeps its code and loses its words, so one nobody has
 * looked at fails closed. Class 22 is why: "invalid input syntax for type uuid" goes on to quote the value.
 */
const CLASSES_QUOTING_NO_VALUE = new Set(["08", "23", "25", "28", "40", "42", "53", "54", "55", "57", "58", "XX"]);
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The driver's and the network's words for not reaching the database, as in CONNECT_TIMEOUT or ECONNRESET. */
const CONNECTION_FAILURE = /^(CONNECT_TIMEOUT|CONNECTION_[A-Z]+|E[A-Z]+)$/;

function quotesNoValue(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return CONNECTION_FAILURE.test(code) || (SQLSTATE.test(code) && CLASSES_QUOTING_NO_VALUE.has(code.slice(0, 2)));
}

function wordsOf(cause: Record<string, unknown>): string {
  if (quotesNoValue(cause.code) && typeof cause.message === "string") return cause.message;
  const code = typeof cause.code === "string" ? cause.code : "no code";
  return `The database or its driver refused this query (${code}). What it said is left out, since it can repeat a value.`;
}

/**
 * The cause without what can repeat a value: `detail` holds a duplicate key or a whole failing row, and
 * `where`, `hint` and `internal_query` can too. It's a new error rather than the driver's with fields
 * removed: a driver's stack opens with its message, and postgres.js also holds the parameters in
 * properties that are hidden but readable, and that can't be removed.
 */
export function causeWithoutValues(cause: unknown): Error | undefined {
  if (cause === undefined || cause === null) return undefined;
  const said = cause as Record<string, unknown>;
  const safe = new Error(wordsOf(said));
  for (const [field, names] of Object.entries(KEPT_FIELDS)) {
    const value = names.map((name) => said[name]).find((found) => typeof found === "string" && found);
    if (value) Object.assign(safe, { [field]: value });
  }
  return safe;
}

let kept = false;

/**
 * A failed query's error says its parameters in its message, and Postgres repeats them in its cause:
 * whatever logs or answers either repeats them, and session tokens and emails would end up in the
 * platform's logs. Every query goes through here, so its error keeps the statement and what's safe of
 * the cause, and loses the values. Drizzle offers no option for this, and tests/query-errors.test.ts
 * fails if an upgrade takes this method away.
 */
export function keepParametersOutOfQueryErrors(): void {
  if (kept) return;
  kept = true;
  const prepared = PgPreparedQuery.prototype as unknown as { queryWithCache: RunQuery };
  const run = prepared.queryWithCache;
  prepared.queryWithCache = async function queryWithoutSayingItsParameters(this: unknown, queryString, params, query) {
    try {
      return await run.call(this, queryString, params, query);
    } catch (error) {
      throw error instanceof DrizzleQueryError ? new DrizzleQueryError(error.query, [], causeWithoutValues(error.cause)) : error;
    }
  };
}
