import type { Signal, SignalType } from "@/application/ports";

/**
 * What a message that reached a mailbox means for prospecting, whichever provider read it: a
 * person's reply, an auto-reply or a bounce. Pure: the adapters hand it what they read.
 *
 * Delivery reports: https://www.rfc-editor.org/rfc/rfc3464
 * Auto-Submitted: https://www.rfc-editor.org/rfc/rfc3834
 * Read receipts: https://www.rfc-editor.org/rfc/rfc8098
 */

/** A message from the inbox, as every provider can give it. */
export interface InboxMessage {
  /** The provider's id for it. */
  id: string;
  receivedAt: Date;
  /** The sender's address, as written; null when the message names none. */
  from: string | null;
  subject: string;
  /** Its headers, by lowercased name (see `headersOf`). */
  headers: Readonly<Record<string, string>>;
  /** Its plain text, with a delivery report's fields when it carries one. */
  text: string;
}

const MAX_DETAIL_LENGTH = 280;

const REPORT = /multipart\/report/i;
const DELIVERY_REPORT = /report-type\s*=\s*"?delivery-status/i;
const MAIL_DAEMON = /^(?:mailer-daemon|postmaster)@/i;

/** RFC 3464's Action field; a report's other values than "failed" say the mail may still arrive. */
const REPORT_ACTION = /^\s*Action:\s*(failed|delayed|delivered|relayed|expanded)\b/gim;
/** For a report whose fields can't be read. Anchored: a bounce's subject quotes the original's. */
const DELAY_SUBJECT = /^\s*(?:delayed mail|delivery delayed|delivery status notification \(delay\)|remise retardée|message retardé)/i;

const ADDRESS = /[^\s<>,;]+@[^\s<>,;]+/;
const RECIPIENT_FIELDS = [/^\s*Final-Recipient:\s*[\w-]+\s*;\s*(.+)$/im, /^\s*Original-Recipient:\s*[\w-]+\s*;\s*(.+)$/im];

const AUTOMATIC_PRECEDENCE = new Set(["auto_reply", "bulk"]);
/** Anchored: "Re: Absence de réponse" is a person answering. */
const AUTO_REPLY_SUBJECT = /^\s*(?:out of (?:the )?office|automatic reply|auto(?:matic)?[- ]?reply|absen(?:ce|t)\b|réponse automatique|message automatique)/i;

/** Where what a person wrote ends: Gmail's, Apple Mail's and Outlook's quote markers, in French and English, or a report's fields. */
const WRITING_ENDS = [
  /^>/,
  /^--$/,
  /^_{5,}$/,
  /\b(?:a écrit|wrote)\s*:$/i,
  /^(?:le|on)\s.*\d{1,2}[:h]\d{2}.*<[^>]+@[^>]+>/i,
  /^-{2,}\s*(?:original message|message d['’]origine|message transféré|forwarded message)/i,
  /^(?:de|from)\s*:\s/i,
  /^reporting-mta:/i,
];

/**
 * A message's headers by lowercased name, unfolded. The first of a repeated header is kept: for
 * what is read here, a message has one, and a later copy would be a forwarder's or a forger's.
 */
export function headersOf(lines: readonly { name: string; value: string }[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, value } of lines) headers[name.toLowerCase()] ??= value.replace(/\r?\n[ \t]+/g, " ").trim();
  return headers;
}

/**
 * What this message means, or null when it means nothing for prospecting: the mailbox's own mail,
 * a read receipt, or a delivery delay (nobody replied, and the mail may still arrive).
 */
export function signalOf(message: InboxMessage, mailbox: string): Signal | null {
  const sender = message.from?.toLowerCase() ?? null;
  if (sender === mailbox.toLowerCase() || isReceipt(message)) return null;
  if (!isBounce(message, sender)) return signal(message, isAutoReply(message) ? "auto_reply" : "replied", sender);
  return isDelayNotice(message) ? null : signal(message, "bounced", failedRecipient(message));
}

/** The signals among these, oldest first, as the reply port promises them. */
export function oldestFirst(signals: readonly (Signal | null)[]): Signal[] {
  return signals.filter((candidate): candidate is Signal => candidate !== null).sort((a, b) => a.at.getTime() - b.at.getTime());
}

function signal(message: InboxMessage, type: SignalType, address: string | null): Signal {
  return { type, channel: "email", externalId: message.id, address, at: message.receivedAt, detail: detailOf(message) || undefined, inReplyTo: answeredMessage(message.headers) };
}

/** A report that isn't about delivery: a read receipt or a spam complaint. */
function isReceipt({ headers }: InboxMessage): boolean {
  const contentType = headers["content-type"] ?? "";
  return REPORT.test(contentType) && !DELIVERY_REPORT.test(contentType);
}

function isBounce({ headers }: InboxMessage, sender: string | null): boolean {
  const contentType = headers["content-type"] ?? "";
  const isDeliveryReport = REPORT.test(contentType) && DELIVERY_REPORT.test(contentType);
  return isDeliveryReport || "x-failed-recipients" in headers || (sender !== null && MAIL_DAEMON.test(sender));
}

function isDelayNotice({ subject, text }: InboxMessage): boolean {
  const actions = [...text.matchAll(REPORT_ACTION)].map(([, action]) => action.toLowerCase());
  return actions.length ? !actions.includes("failed") : DELAY_SUBJECT.test(subject);
}

/** Who a bounce is about: the failed recipient, never the daemon that reported it. */
function failedRecipient({ headers, text }: InboxMessage): string | null {
  const reported = RECIPIENT_FIELDS.map((field) => field.exec(text)?.[1]);
  for (const candidate of [headers["x-failed-recipients"], ...reported]) {
    const address = candidate && ADDRESS.exec(candidate)?.[0];
    if (address) return address.toLowerCase();
  }
  return null;
}

function isAutoReply({ headers, subject }: InboxMessage): boolean {
  const submitted = headers["auto-submitted"]?.split(";")[0].trim().toLowerCase();
  if (submitted && submitted !== "no") return true;
  if ("x-autoreply" in headers || "x-autorespond" in headers) return true;
  return AUTOMATIC_PRECEDENCE.has(headers.precedence?.trim().toLowerCase() ?? "") || AUTO_REPLY_SUBJECT.test(subject);
}

/** The Message-ID this one answers, to find the step it came from: In-Reply-To, or the last of References. */
function answeredMessage(headers: InboxMessage["headers"]): string | undefined {
  const inReplyTo = /<[^<>\s]+>/.exec(headers["in-reply-to"] ?? "")?.[0];
  return inReplyTo ?? headers.references?.match(/<[^<>\s]+>/g)?.at(-1);
}

function detailOf({ subject, text }: InboxMessage): string {
  const characters = Array.from([subject, firstLines(text)].filter(Boolean).join("\n"));
  return characters.length > MAX_DETAIL_LENGTH ? `${characters.slice(0, MAX_DETAIL_LENGTH - 1).join("")}…` : characters.join("");
}

/** What the person wrote, on one line, without the message they quoted. */
function firstLines(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const end = lines.findIndex((line) => WRITING_ENDS.some((marker) => marker.test(line)));
  return (end < 0 ? lines : lines.slice(0, end)).filter(Boolean).join(" ");
}
