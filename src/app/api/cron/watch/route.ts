import { runAllWatchlists } from "@/application/watchlists";
import { appServices } from "@/infrastructure/services";
import { cronRefusal, scheduledWork } from "../scheduled-work";

/** Vercel cron: every watchlist looks at what was announced since it last ran. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await scheduledWork()).watching) return Response.json({ checked: 0, added: 0, idle: true });
  return Response.json(await runAllWatchlists(appServices()));
}
