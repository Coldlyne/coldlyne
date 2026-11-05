import type { Signal } from "@/application/ports";
import { ProviderError } from "../http";

/**
 * What the SMS providers report, in Coldlyne's terms: a reply or a STOP from a prospect, a message
 * delivered or not. Shared by the SMS adapters, which each read their provider's own format.
 */

/** The ways people write STOP, once accents, case, spaces and punctuation are set aside. */
const STOP_WORDS = new Set(["stop", "arret", "stopsms", "arretsms"]);

/** Whether a reply asks to stop: STOP, ARRET, ARRÊT, STOP SMS, in any case and spacing. */
export function isStop(text: string): boolean {
  const letters = text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}]/gu, "").toLowerCase();
  return STOP_WORDS.has(letters);
}

/**
 * A number as providers write it ("+33 6 12…", "0033612…", "33612…") in E.164. A ten-digit number
 * starting with a single 0 is French, the only national format these providers report.
 */
export function e164(raw: string): string | null {
  const compact = raw.replace(/[\s.()/-]/g, "");
  const international = compact.startsWith("+") ? compact.slice(1) : compact.startsWith("00") ? compact.slice(2) : /^0\d{9}$/.test(compact) ? `33${compact.slice(1)}` : compact;
  return /^[1-9]\d{7,14}$/.test(international) ? `+${international}` : null;
}

/**
 * Someone who asked to stop. A person opts out once, however many ways the provider says so (a
 * STOP reply, its own unsubscribe event, its blocklist), so the id is theirs, not the event's.
 */
export function optOutSignal(optOut: { from: string; at: Date; detail?: string }): Signal {
  const address = e164(optOut.from);
  return { type: "opted_out", channel: "sms", externalId: `stop:${address ?? optOut.from}`, address, at: optOut.at, ...(optOut.detail ? { detail: optOut.detail } : {}) };
}

/** A prospect's answer: a STOP opts them out of every channel, anything else is a reply. */
export function replySignal(reply: { externalId: string; from: string; text: string; at: Date }): Signal {
  const detail = reply.text.trim();
  if (isStop(reply.text)) return optOutSignal({ from: reply.from, at: reply.at, detail });
  return { type: "replied", channel: "sms", externalId: reply.externalId, address: e164(reply.from), at: reply.at, detail };
}

/**
 * A delivery report: delivered, or failed with the provider's reason. Its id is the message's
 * and the outcome, since a message reported failed for a while can still be delivered later.
 */
export function deliverySignal(report: { messageId: string; to: string; delivered: boolean; at: Date; detail?: string }): Signal {
  const type = report.delivered ? "delivered" : "failed";
  return { type, channel: "sms", externalId: `${report.messageId}:${type}`, address: e164(report.to), at: report.at, ...(report.detail ? { detail: report.detail } : {}) };
}

/**
 * A date a provider wrote, or the fallback when it wrote none Coldlyne can read. One that names no
 * zone is read as UTC, so the result doesn't depend on the zone of the server reading it.
 */
export function readDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** The events in what a provider posted: one, or a batch. Throws when it can't be read. */
export function webhookEvents<Event>(provider: string, body: string): Event[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderError(provider, 400, `${provider} a envoyé une notification illisible.`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new ProviderError(provider, 400, `${provider} a envoyé une notification illisible.`);
  return (Array.isArray(parsed) ? parsed : [parsed]) as Event[];
}
