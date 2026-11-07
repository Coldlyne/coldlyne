import { syncEveryWorkspace } from "@/application/signals";
import { isDailyReadHour } from "@/domain/crm-exclusions";
import { appServices } from "@/infrastructure/services";
import { cronRefusal, scheduledWork } from "../scheduled-work";

/** Vercel cron: reads every workspace's mailboxes, calendars and incoming SMS, and looks at its linked CRM, which has an hour of its own. */
export async function GET(request: Request) {
  const refusal = cronRefusal(request);
  if (refusal) return refusal;
  const { reading, linking } = await scheduledWork();
  if (!reading && !(linking && isDailyReadHour(new Date()))) return Response.json({ workspaces: 0, added: 0, idle: true });
  return Response.json(await syncEveryWorkspace(appServices()));
}
