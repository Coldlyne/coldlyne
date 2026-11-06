import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

type RunQuery = (queryString: string, params: unknown[], query: () => Promise<unknown>) => Promise<unknown>;

let kept = false;

/**
 * A failed query's error says its parameters in its message, and whatever logs or answers it repeats
 * them: session tokens and emails would end up in the platform's logs. Every query goes through here,
 * so its error keeps the statement and the cause, and loses the values. Drizzle offers no option for
 * this, and tests/query-errors.test.ts fails if an upgrade takes this method away.
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
      throw error instanceof DrizzleQueryError ? new DrizzleQueryError(error.query, [], error.cause) : error;
    }
  };
}
