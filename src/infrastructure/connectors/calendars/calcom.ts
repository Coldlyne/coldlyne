import type { InboundRequest, Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { bearerJson, requestJson } from "../http";
import { everyPage } from "../pages";
import { meetingSignals, type Meeting } from "./meetings";
import { hookSecret, signatureMatches } from "./webhook";

/**
 * Cal.com, through API v2, and its webhooks. A booking's `uid` names it in both, so a booking heard
 * of twice is recorded once. Rescheduling gives a booking a new uid: it reads as a new booking,
 * and the old one, though cancelled, as nothing, since the prospect still has a meeting.
 *
 * The signature's encoding comes from Cal.com's source, not its docs, which leave it unsaid.
 *
 * Docs:
 * - https://cal.com/docs/api-reference/v2/bookings/get-all-bookings
 * - https://cal.com/docs/api-reference/v2/me/get-my-profile
 * - https://cal.com/docs/developing/guides/automation/webhooks
 * - https://github.com/calcom/cal.com/blob/main/packages/features/webhooks/lib/sendPayload.ts
 */

const PROVIDER = "Cal.com";
const API = "https://api.cal.com/v2";
/** The bookings endpoint requires this version; /me documents no version header. */
const BOOKINGS_VERSION = "2026-05-01";
const PAGE_SIZE = "100";

interface Booking {
  uid: string;
  title?: string;
  status?: string;
  start?: string;
  createdAt?: string;
  /** Nullable in Cal.com's schema: a booking never changed may have none. */
  updatedAt?: string | null;
  /** Set on the old booking when it was moved to a new one. */
  rescheduledToUid?: string;
  attendees?: { email?: string }[];
}

interface BookingsPage {
  data?: Booking[];
  pagination?: { nextCursor?: string | null; hasMore?: boolean };
}

interface CalProfile {
  data?: { email?: string; name?: string | null };
}

interface CalWebhook {
  triggerEvent?: string;
  createdAt?: string;
  payload?: {
    uid?: string;
    title?: string;
    startTime?: string;
    organizer?: { email?: string };
    attendees?: { email?: string }[];
  };
}

const guestsOf = (attendees: { email?: string }[] = []) => attendees.flatMap(({ email }) => (email ? [{ email }] : []));

/** A booking that counts: accepted, or cancelled outright. Requests still waiting and refused ones were never meetings. */
function meetingOf(booking: Booking): Meeting[] {
  const cancelled = booking.status === "cancelled" && !booking.rescheduledToUid;
  if (!cancelled && booking.status !== "accepted") return [];
  return [
    {
      id: booking.uid,
      title: booking.title,
      start: booking.start ? { at: booking.start } : null,
      cancelled,
      bookedAt: booking.createdAt,
      changedAt: booking.updatedAt,
      guests: guestsOf(booking.attendees),
    },
  ];
}

const WEBHOOK_MEANS: Record<string, "booked" | "cancelled"> = { BOOKING_CREATED: "booked", BOOKING_RESCHEDULED: "booked", BOOKING_CANCELLED: "cancelled" };

function meetingFromWebhook({ triggerEvent, createdAt, payload }: CalWebhook): Meeting[] {
  const means = WEBHOOK_MEANS[triggerEvent ?? ""];
  if (!means || !payload?.uid) return [];
  return [
    {
      id: payload.uid,
      title: payload.title,
      start: payload.startTime ? { at: payload.startTime } : null,
      cancelled: means === "cancelled",
      bookedAt: createdAt,
      changedAt: createdAt,
      guests: guestsOf(payload.attendees),
    },
  ];
}

export const calcom: Adapter = (context) => {
  const auth = bearerJson(context.fields.apiKey);

  /** Every booking matching a date filter, whatever its status. */
  async function bookings(filter: Record<string, string>): Promise<Booking[]> {
    const pages = await everyPage(
      (cursor) => {
        const query = new URLSearchParams({ ...filter, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
        return requestJson<BookingsPage>(context.fetch, PROVIDER, `${API}/bookings?${query}`, { headers: { ...auth, "cal-api-version": BOOKINGS_VERSION } });
      },
      (page) => (page.pagination?.hasMore ? page.pagination.nextCursor : null),
    );
    return pages.flatMap((page) => page.data ?? []);
  }

  const profile = async () => (await requestJson<CalProfile>(context.fetch, PROVIDER, `${API}/me`, { headers: auth })).data;

  return {
    check: () =>
      checked(PROVIDER, async () => {
        const account = await profile();
        return { ok: true, detail: `Compte ${account?.name ?? account?.email}`, label: account?.email ?? account?.name ?? undefined };
      }),

    async meetingsSince(since: Date): Promise<Signal[]> {
      const account = await profile();
      const from = since.toISOString();
      // updatedAt may be null on a new booking, so changes alone would miss it: ask for both.
      const [created, updated] = await Promise.all([bookings({ afterCreatedAt: from }), bookings({ afterUpdatedAt: from })]);
      const distinct = new Map([...created, ...updated].map((booking) => [booking.uid, booking]));
      return meetingSignals([...distinct.values()].flatMap(meetingOf), account?.email ?? "", context.now());
    },

    async readWebhook(request: InboundRequest) {
      const signature = request.headers.get("x-cal-signature-256") ?? "";
      if (!signatureMatches(hookSecret(context.hookUrl), request.body, signature)) throw new Error("La signature de ce webhook Cal.com est fausse.");
      const event = JSON.parse(request.body) as CalWebhook;
      return { signals: meetingSignals(meetingFromWebhook(event), event.payload?.organizer?.email ?? "", context.now()) };
    },
  };
};
