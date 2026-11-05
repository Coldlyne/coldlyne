import type { Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, ProviderError, requestJson } from "../http";
import { everyPage } from "../pages";
import { meetingSignals, type Meeting } from "./meetings";

/**
 * Google Agenda, through Calendar API v3, on the member's primary calendar.
 *
 * A deleted event is only guaranteed its id: one that comes back without its attendees can't be
 * pinned on a guest, so it gives no signal.
 *
 * Docs:
 * - https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 * - https://developers.google.com/workspace/calendar/api/v3/reference/events
 * - https://developers.google.com/identity/openid-connect/openid-connect (the userinfo endpoint)
 */

const PROVIDER = "Google Agenda";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  created?: string;
  updated?: string;
  /** Set on each occurrence of a recurring event. */
  recurringEventId?: string;
  start?: { date?: string; dateTime?: string };
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
}

interface EventsPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

function startOf(event: GoogleEvent): Meeting["start"] {
  if (event.start?.dateTime) return { at: event.start.dateTime };
  return event.start?.date ? { at: event.start.date, allDay: true } : null;
}

function meetingOf(event: GoogleEvent): Meeting {
  return {
    // singleEvents lists each occurrence: a weekly meeting is still one meeting booked.
    id: event.recurringEventId ?? event.id,
    title: event.summary,
    start: startOf(event),
    cancelled: event.status === "cancelled",
    bookedAt: event.created,
    changedAt: event.updated,
    guests: (event.attendees ?? []).flatMap((attendee) => (attendee.email && !attendee.self && !attendee.resource ? [{ email: attendee.email, declined: attendee.responseStatus === "declined" }] : [])),
  };
}

export const googleCalendar: Adapter = (context) => {
  const headers = async () => bearerJson(await context.accessToken());

  async function accountEmail(): Promise<string> {
    const { email } = await requestJson<{ email?: string }>(context.fetch, PROVIDER, USERINFO, { headers: await headers() });
    // Without it, colleagues would count as prospects: better to say so than to guess.
    if (!email) throw new ProviderError(PROVIDER, 403, "Google Agenda ne donne pas l’adresse de ce compte : reconnectez-le en autorisant l’adresse e-mail.");
    return email;
  }

  const eventsPage = async (params: Record<string, string>) => requestJson<EventsPage>(context.fetch, PROVIDER, `${EVENTS}?${new URLSearchParams(params)}`, { headers: await headers() });

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const email = await accountEmail();
        // Signing in proves the account, not the calendar scope: read one event to prove that too.
        await eventsPage({ maxResults: "1" });
        return { ok: true, detail: `Agenda de ${email}`, label: email };
      }),

    async meetingsSince(since: Date): Promise<Signal[]> {
      const account = await accountEmail();
      const query = { updatedMin: since.toISOString(), showDeleted: "true", singleEvents: "true", maxResults: "250" };
      const pages = await everyPage(
        (pageToken) => eventsPage(pageToken ? { ...query, pageToken } : query),
        (page) => page.nextPageToken,
      );
      return meetingSignals(pages.flatMap((page) => (page.items ?? []).map(meetingOf)), account, context.now());
    },
  };
};
