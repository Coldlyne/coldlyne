import type { Signal } from "@/application/ports";

/**
 * What every calendar comes down to: who met whom, about what, and whether it still stands. Each
 * adapter reads its provider into a `Meeting`; turning those into signals happens once, here.
 */

export interface MeetingGuest {
  email: string;
  /** They said no to the invitation: for them, the meeting is off even if it still stands. */
  declined?: boolean;
}

export interface Meeting {
  /** The event's or booking's id, the same whichever way Coldlyne heard of it. */
  id: string;
  title?: string | null;
  start?: { at: string; allDay?: boolean } | null;
  cancelled: boolean;
  bookedAt?: string | null;
  changedAt?: string | null;
  guests: MeetingGuest[];
}

/** Everyone's mailbox, not a company's: sharing one of these domains doesn't make someone a colleague. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "laposte.net",
]);

const addressOf = (email: string) => email.trim().toLowerCase();
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** Whether a guest is outside the account's own domain, and so may be a prospect. */
function isOutside(guest: string, account: string): boolean {
  if (guest === account) return false;
  return PUBLIC_MAIL_DOMAINS.has(domainOf(account)) || domainOf(guest) !== domainOf(account);
}

// The signal has no workspace to read a time zone from, and Coldlyne's members are in France.
const WHEN = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });
const DAY = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" });

function detailOf({ title, start }: Meeting): string {
  const name = title?.trim() || "Rendez-vous sans titre";
  return start ? `${name}, le ${(start.allDay ? DAY : WHEN).format(new Date(start.at))}` : name;
}

function signalOf(meeting: Meeting, guest: MeetingGuest, now: Date): Signal {
  const cancelled = meeting.cancelled || guest.declined === true;
  const address = addressOf(guest.email);
  const at = cancelled ? (meeting.changedAt ?? meeting.bookedAt) : (meeting.bookedAt ?? meeting.changedAt);
  return {
    type: cancelled ? "meeting_cancelled" : "meeting_booked",
    channel: "calendar",
    // A cancellation has an id of its own: under the booking's, it would be dropped as a repeat.
    externalId: `${meeting.id}:${address}${cancelled ? ":cancelled" : ""}`,
    address,
    at: at ? new Date(at) : now,
    detail: detailOf(meeting),
  };
}

/** One signal per guest outside the account's domain, oldest first, each only once. */
export function meetingSignals(meetings: readonly Meeting[], account: string, now: Date): Signal[] {
  const own = addressOf(account);
  const signals = meetings
    .flatMap((meeting) => meeting.guests.filter((guest) => isOutside(addressOf(guest.email), own)).map((guest) => signalOf(meeting, guest, now)))
    .sort((earlier, later) => earlier.at.getTime() - later.at.getTime());
  return [...new Map(signals.map((signal) => [signal.externalId, signal])).values()];
}
