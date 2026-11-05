import { revalidateTag } from "next/cache";

/**
 * What the scheduled jobs know without asking the database: whether they have anything to do. It
 * lives in the platform's cache, so a job with nothing to do doesn't wake a database that bills by
 * the hour it is awake. Whatever gives them work, or takes it away, clears it.
 */
export const SCHEDULED_WORK_TAG = "scheduled-work";

/**
 * Clears what's known, so the next run asks. Next applies it when the request's route returns, so a
 * change has to happen before that. Outside a request (a test, a script) nothing is cached to clear.
 */
export function scheduledWorkChanged(): void {
  try {
    revalidateTag(SCHEDULED_WORK_TAG, { expire: 0 });
  } catch {
    // Only reachable outside a request; at worst the jobs find out at the cache's daily refresh.
  }
}
