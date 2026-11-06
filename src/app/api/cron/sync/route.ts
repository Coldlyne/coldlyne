import { syncEveryWorkspace } from "@/application/signals";
import { appServices } from "@/infrastructure/services";
import { cronRefusal, scheduledWork } from "../scheduled-work";

/** Vercel cron: reads every workspace's mailboxes, calendars and incoming SMS. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  if (!(await scheduledWork()).reading) return Response.json({ workspaces: 0, added: 0, idle: true });
  return Response.json(await syncEveryWorkspace(appServices()));
}
