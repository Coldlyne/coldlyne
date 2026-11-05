import type { InboundRequest, Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { everyPage } from "../pages";
import { meetingSignals, type Meeting } from "./meetings";
import { hookSecret, signatureMatches } from "./webhook";

/**
 * Calendly, through API v2 with a personal access token, and its webhooks.
 *
 * Reads the token owner's events (`user`), not the organization's, which needs an admin's token.
 * Events can only be filtered by start time, but a meeting booked or cancelled since a date starts
 * after it (one can't book the past), so `min_start_time` is enough and the rest is sorted here.
 *
 * Webhook subscriptions need a paid plan and are only made through the API; a free account still
 * reads its events, at 50 requests a minute. Hence no request for an event that can't have changed.
 *
 * Docs:
 * - https://developer.calendly.com/api-docs/calendly-api/users/get-current-user.md
 * - https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-scheduled-events.md
 * - https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-event-invitees.md
 * - https://developer.calendly.com/api-docs/calendly-api/webhooks/get-sample-webhook-data.md
 * - https://developer.calendly.com/api-docs/calendly-api/webhooks/create-webhook-subscription.md
 * - https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures.md
 * - https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events.md
 * - https://developer.calendly.com/api-docs/overview/rate-limits.md
 * - https://calendly.com/help/webhooks-overview
 */

const PROVIDER = "Calendly";
const API = "https://api.calendly.com";
const PAGE_SIZE = "100";
/** Calendly's advice against replays: an older signature is refused. */
const SIGNATURE_TOLERANCE_MS = 3 * 60 * 1000;

interface CalendlyEvent {
  uri?: string;
  name?: string | null;
  status?: string;
  start_time?: string;
  updated_at?: string;
  invitees_counter?: { limit?: number };
  event_memberships?: { user_email?: string }[];
}

interface Invitee {
  email?: string;
  status?: string;
  /** The URI of the invitee's event. */
  event?: string;
  /** Cancelled only to move to another time: the prospect still has a meeting. */
  rescheduled?: boolean;
  created_at?: string;
  updated_at?: string;
  cancellation?: { created_at?: string };
}

interface Page<T> {
  collection?: T[];
  pagination?: { next_page_token?: string | null };
}

interface CalendlyUser {
  uri: string;
  name?: string;
  email?: string;
}

interface CalendlyWebhook {
  event?: string;
  payload?: Invitee & { scheduled_event?: CalendlyEvent };
}

const uuidOf = (uri = "") => uri.slice(uri.lastIndexOf("/") + 1);
const changedSince = (at: string | undefined, since: Date) => (at ? new Date(at).getTime() >= since.getTime() : false);

/** An invitee's cancellation may leave a group event untouched; on a one-on-one it cancels the event. */
const mayHaveChanged = (event: CalendlyEvent, since: Date) => changedSince(event.updated_at, since) || (event.invitees_counter?.limit ?? 1) > 1;

function meetingOf(event: CalendlyEvent, invitee: Invitee): Meeting[] {
  if (!invitee.email || (invitee.status === "canceled" && invitee.rescheduled)) return [];
  const cancelled = invitee.status === "canceled" || event.status === "canceled";
  return [
    {
      // The event's, on both roads here: the API's list and the webhook name the same meeting alike.
      id: uuidOf(invitee.event ?? event.uri),
      title: event.name,
      start: event.start_time ? { at: event.start_time } : null,
      cancelled,
      bookedAt: invitee.created_at,
      changedAt: invitee.cancellation?.created_at ?? invitee.updated_at,
      guests: [{ email: invitee.email }],
    },
  ];
}

/** Throws unless Calendly signed this body, recently: `t=<seconds>,v1=<HMAC of "t.body">`. */
function verifySignature(request: InboundRequest, secret: string, now: Date): void {
  const parts = new Map((request.headers.get("calendly-webhook-signature") ?? "").split(",").map((part) => part.trim().split("=") as [string, string]));
  const [sentAt, signature] = [parts.get("t"), parts.get("v1")];
  if (!sentAt || !signature || !signatureMatches(secret, `${sentAt}.${request.body}`, signature)) throw new Error("La signature de ce webhook Calendly est fausse.");
  // Written this way round so that a `t` that isn't a number (NaN) is refused too.
  if (!(Math.abs(now.getTime() - Number(sentAt) * 1000) <= SIGNATURE_TOLERANCE_MS)) throw new Error("La signature de ce webhook Calendly est trop ancienne.");
}

export const calendly: Adapter = (context) => {
  const headers = bearerJson(context.fields.token);
  const get = <T>(url: string) => requestJson<T>(context.fetch, PROVIDER, url, { headers });
  const currentUser = async () => (await get<{ resource: CalendlyUser }>(`${API}/users/me`)).resource;

  /** Every row of a list, a page at a time. */
  async function all<T>(path: string, filter: Record<string, string> = {}): Promise<T[]> {
    const pages = await everyPage(
      (pageToken) => get<Page<T>>(`${API}${path}?${new URLSearchParams({ ...filter, count: PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) })}`),
      (page) => page.pagination?.next_page_token,
    );
    return pages.flatMap((page) => page.collection ?? []);
  }

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const user = await currentUser();
        return { ok: true, detail: `Compte ${user.name ?? user.email}`, label: user.email ?? user.name };
      }),

    async meetingsSince(since: Date): Promise<Signal[]> {
      const user = await currentUser();
      const events = await all<CalendlyEvent>("/scheduled_events", { user: user.uri, min_start_time: since.toISOString() });
      const meetings: Meeting[] = [];
      // One after the other: a free plan's 50 requests a minute wouldn't survive a burst.
      for (const event of events.filter((candidate) => mayHaveChanged(candidate, since))) {
        const invitees = await all<Invitee>(`/scheduled_events/${uuidOf(event.uri)}/invitees`);
        const changed = invitees.filter((invitee) => changedSince(invitee.updated_at, since) || changedSince(event.updated_at, since));
        meetings.push(...changed.flatMap((invitee) => meetingOf(event, invitee)));
      }
      return meetingSignals(meetings, user.email ?? "", context.now());
    },

    async readWebhook(request: InboundRequest) {
      verifySignature(request, hookSecret(context.hookUrl), context.now());
      const { event, payload } = JSON.parse(request.body) as CalendlyWebhook;
      if ((event !== "invitee.created" && event !== "invitee.canceled") || !payload) return { signals: [] };
      const scheduled = payload.scheduled_event ?? {};
      return { signals: meetingSignals(meetingOf(scheduled, payload), scheduled.event_memberships?.[0]?.user_email ?? "", context.now()) };
    },
  };
};
