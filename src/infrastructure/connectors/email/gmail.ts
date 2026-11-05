import { parse as parseHtml } from "node-html-parser";
import addressparser from "nodemailer/lib/addressparser";
import type { OutgoingEmail, SentMessage, Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { bearerJson, requestJson } from "../http";
import { headersOf, oldestFirst, signalOf, type InboxMessage } from "./classify";
import { checkMailbox, mailboxOf, type Mailbox } from "./mailbox";
import { composeMessage } from "./mime";

/**
 * A Gmail or Google Workspace mailbox, through the Gmail API.
 *
 * Sending: https://developers.google.com/workspace/gmail/api/guides/sending
 * Threads: https://developers.google.com/workspace/gmail/api/guides/threads
 * Reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 * Profile: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 * Searching by date: https://developers.google.com/workspace/gmail/api/guides/filtering
 * The INBOX label: https://developers.google.com/workspace/gmail/api/guides/labels
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROVIDER = "Gmail";
const LIST_PAGE_SIZE = "100";

/** The parts whose text is read; a delivery report's fields are how a bounce names its recipient. */
const READABLE_PARTS = new Set(["text/plain", "message/delivery-status"]);

interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

interface GmailMessageList {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

/** A call to the mailbox's part of the API, with a fresh token. */
type GmailCall = <T>(path: string, init?: RequestInit) => Promise<T>;

export const gmailAdapter: Adapter = (context) => {
  const call: GmailCall = async <T>(path: string, init: RequestInit = {}) =>
    requestJson<T>(context.fetch, PROVIDER, `${API}${path}`, { ...init, headers: bearerJson(await context.accessToken()) });

  return {
    check: () => checkMailbox(PROVIDER, async () => (await call<{ emailAddress: string }>("/profile")).emailAddress),
    sendEmail: async (email) => sendEmail(call, mailboxOf(context.fields), email, context.now()),
    signalsSince: async (since) => signalsSince(call, mailboxOf(context.fields), since),
  };
};

async function sendEmail(call: GmailCall, mailbox: Mailbox, email: OutgoingEmail, date: Date): Promise<SentMessage> {
  const { raw, messageId } = await composeMessage(mailbox, email, date);
  const threadId = email.inReplyTo ? await threadOf(call, email.inReplyTo) : undefined;
  const sent = await call<GmailMessage>("/messages/send", { method: "POST", body: JSON.stringify({ raw: raw.toString("base64url"), threadId }) });
  return { externalId: sent.id, messageId, threadId: sent.threadId };
}

/** The Gmail thread of a message already sent: without it, a follow-up opens a new thread in the member's Gmail. */
async function threadOf(call: GmailCall, messageId: string): Promise<string | undefined> {
  const params = new URLSearchParams({ q: `rfc822msgid:${messageId.replace(/[<>]/g, "")}`, maxResults: "1" });
  const found = await call<GmailMessageList>(`/messages?${params}`);
  return found.messages?.[0]?.threadId;
}

async function signalsSince(call: GmailCall, mailbox: Mailbox, since: Date): Promise<Signal[]> {
  const signals: (Signal | null)[] = [];
  for (const id of await inboxMessageIds(call, since)) {
    const message = await call<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    signals.push(signalOf(inboxMessage(message), mailbox.address));
  }
  return oldestFirst(signals);
}

/** Dates in a Gmail search mean midnight, Pacific time, unless given in seconds. */
async function inboxMessageIds(call: GmailCall, since: Date): Promise<string[]> {
  const params = new URLSearchParams({ q: `after:${Math.floor(since.getTime() / 1000)} -from:me`, labelIds: "INBOX", maxResults: LIST_PAGE_SIZE });
  const ids: string[] = [];
  for (;;) {
    const page = await call<GmailMessageList>(`/messages?${params}`);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    if (!page.nextPageToken) return ids;
    params.set("pageToken", page.nextPageToken);
  }
}

function inboxMessage(message: GmailMessage): InboxMessage {
  const headers = headersOf(message.payload?.headers ?? []);
  return {
    id: message.id,
    receivedAt: new Date(Number(message.internalDate)),
    from: addressparser(headers.from ?? "").find((entry) => entry.address)?.address ?? null,
    subject: headers.subject ?? "",
    headers,
    text: (message.payload && textOf(message.payload)) || snippetText(message.snippet),
  };
}

function textOf(part: GmailPart): string {
  const own = READABLE_PARTS.has(part.mimeType ?? "") && part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
  return [own, ...(part.parts ?? []).map(textOf)].filter(Boolean).join("\n");
}

/** For a message with no text part: Gmail's snippet, whose apostrophes and ampersands come escaped. */
function snippetText(snippet = ""): string {
  return parseHtml(snippet).text;
}
