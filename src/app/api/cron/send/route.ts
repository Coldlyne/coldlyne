import { runScheduler } from "@/application/scheduler";
import { appServices } from "@/infrastructure/services";
import { cronRefusal, scheduledWork } from "../scheduled-work";

/** Vercel cron: whoever is due gets their step, a few at a time, within windows and caps. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await scheduledWork()).sending) return Response.json({ workspaces: 0, sent: 0, idle: true });
  return Response.json(await runScheduler(appServices()));
}
