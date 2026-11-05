import type { Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { everyPage } from "../pages";
import { meetingSignals, type Meeting } from "./meetings";

/**
 * Agenda Outlook, through Microsoft Graph: the events changed since a date, not calendarView delta.
 *
 * Delta needs a stored deltaLink, which `meetingsSince(since)` has nowhere to keep; its first round
 * returns everything in the window rather than what changed; it refuses $filter and $select; and
 * a deleted event comes back as an id under @removed, without the attendees a signal needs.
 *
 * What that leaves out: a meeting the member organized and then deleted is gone from the list.
 * A guest declining and an organizer cancelling (isCancelled, on the member's copy) are both seen.
 *
 * Docs:
 * - https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0
 * - https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0
 * - https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0
 * - https://learn.microsoft.com/en-us/graph/api/resources/attendee?view=graph-rest-1.0
 */

const PROVIDER = "Agenda Outlook";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** The page size: Graph's default of 10 would mean a request for every ten events. */
const PAGE_SIZE = 50;

interface GraphEvent {
  id: string;
  subject?: string | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isCancelled?: boolean;
  /** Updated in Outlook but not sent yet: the guests don't know about it. */
  isDraft?: boolean;
  isAllDay?: boolean;
  start?: { dateTime?: string } | null;
  attendees?: { type?: string; status?: { response?: string }; emailAddress?: { address?: string } }[];
}

interface EventsPage {
  value?: GraphEvent[];
  "@odata.nextLink"?: string;
}

interface GraphUser {
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

/** Graph gives start times in UTC without saying so, unless asked for another time zone. */
function startOf(event: GraphEvent): Meeting["start"] {
  return event.start?.dateTime ? { at: `${event.start.dateTime}Z`, allDay: event.isAllDay } : null;
}

function meetingOf(event: GraphEvent): Meeting {
  return {
    id: event.id,
    title: event.subject,
    start: startOf(event),
    cancelled: event.isCancelled === true,
    bookedAt: event.createdDateTime,
    changedAt: event.lastModifiedDateTime,
    guests: (event.attendees ?? []).flatMap((attendee) => (attendee.emailAddress?.address && attendee.type !== "resource" ? [{ email: attendee.emailAddress.address, declined: attendee.status?.response === "declined" }] : [])),
  };
}

export const microsoftCalendar: Adapter = (context) => {
  const get = async <T>(url: string) => requestJson<T>(context.fetch, PROVIDER, url, { headers: bearerJson(await context.accessToken()) });
  const currentUser = () => get<GraphUser>(`${GRAPH}/me?$select=displayName,mail,userPrincipalName`);

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const user = await currentUser();
        // Signing in proves the account, not Calendars.Read: read one event to prove that too.
        await get<EventsPage>(`${GRAPH}/me/events?$top=1&$select=id`);
        const address = user.mail ?? user.userPrincipalName ?? undefined;
        return { ok: true, detail: `Agenda de ${user.displayName ?? address}`, label: address ?? user.displayName ?? undefined };
      }),

    async meetingsSince(since: Date): Promise<Signal[]> {
      const user = await currentUser();
      const first = `${GRAPH}/me/events?$top=${PAGE_SIZE}&$filter=${encodeURIComponent(`lastModifiedDateTime ge ${since.toISOString()}`)}`;
      const pages = await everyPage(
        (next) => get<EventsPage>(next ?? first),
        (page) => page["@odata.nextLink"],
      );
      const meetings = pages.flatMap((page) => page.value ?? []).filter((event) => !event.isDraft).map(meetingOf);
      return meetingSignals(meetings, user.mail ?? user.userPrincipalName ?? "", context.now());
    },
  };
};
