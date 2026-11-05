import { cacheLife, cacheTag } from "next/cache";
import { whatIsScheduled, type ScheduledWork } from "@/application/scheduled-work";
import { sameSecret } from "@/infrastructure/crypto/secrets";
import { db } from "@/infrastructure/db/client";
import { env } from "@/infrastructure/env";
import { SCHEDULED_WORK_TAG } from "@/infrastructure/scheduling/scheduled-work";

const DAY_SECONDS = 86_400;

/**
 * What the jobs have to do, kept outside the database so that asking doesn't wake it. Whatever
 * changes it clears it at once; the daily refresh is only the safety net for a change made by hand.
 */
export async function scheduledWork(): Promise<ScheduledWork> {
  "use cache: remote";
  cacheTag(SCHEDULED_WORK_TAG);
  cacheLife({ revalidate: DAY_SECONDS, expire: 2 * DAY_SECONDS });
  return whatIsScheduled(db());
}

/** The refusal for anyone but Vercel's cron, or null when it's Vercel's cron. */
export function cronRefusal(request: Request): Response | null {
  const secret = env().CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return secret && sameSecret(given, secret) ? null : new Response(null, { status: 401 });
}
