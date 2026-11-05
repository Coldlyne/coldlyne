import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { OutgoingEmail, SentMessage, Signal } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { isInternalHost } from "../hosts";
import { ProviderError } from "../http";
import { oldestFirst, signalOf, type InboxMessage } from "./classify";
import { checkMailbox, mailboxOf } from "./mailbox";
import { composeMessage, readMessage } from "./mime";

/**
 * Any mailbox a member can reach with a password: sends over SMTP, reads over IMAP. The sockets
 * come from `SmtpDeps`, so tests can stand in for the servers.
 *
 * SMTP: https://nodemailer.com/smtp
 * A message already built: https://nodemailer.com/message/custom-source
 * IMAP: https://imapflow.com/docs/api/imapflow-client
 * SEARCH SINCE ignores the time of day: https://www.rfc-editor.org/rfc/rfc3501#section-6.4.4
 */

const SMTPS_PORT = 465;
const IMAPS_PORT = 993;
const CONNECTION_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Headers and first lines are at the start; a large attachment needn't come down with them. */
const MAX_SOURCE_BYTES = 256 * 1024;
const SENT_FOLDER = "\\Sent";

/** Where one of the mailbox's two servers is, and how to sign in to it. */
export interface MailServer {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** What is used of a nodemailer transport. */
export interface SmtpTransport {
  verify(): Promise<unknown>;
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<unknown>;
}

export interface FetchedMessage {
  uid: number;
  internalDate?: Date | string;
  source?: Buffer;
}

/** What is used of an ImapFlow client. */
export interface ImapSession {
  connect(): Promise<void>;
  logout(): Promise<unknown>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  append(path: string, content: Buffer, flags: string[], date: Date): Promise<unknown>;
  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }>;
  search(query: { since: Date }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: number[], query: { uid: true; internalDate: true; source?: { maxLength: number } }, options: { uid: true }): Promise<FetchedMessage[]>;
}

export interface SmtpDeps {
  createTransport(server: MailServer): SmtpTransport;
  createImapClient(server: MailServer): ImapSession;
}

/** Secure from the first byte on 465; anywhere else STARTTLS is required, so a password never travels in clear. */
export function smtpOptions({ host, port, user, pass }: MailServer) {
  const secure = port === SMTPS_PORT;
  return { host, port, secure, requireTLS: !secure, auth: { user, pass }, connectionTimeout: CONNECTION_TIMEOUT_MS, greetingTimeout: CONNECTION_TIMEOUT_MS };
}

/** The same for IMAP: secure from the first byte on 993, STARTTLS required anywhere else. */
export function imapOptions({ host, port, user, pass }: MailServer) {
  const secure = port === IMAPS_PORT;
  return { host, port, secure, doSTARTTLS: secure ? undefined : true, auth: { user, pass }, logger: false as const, connectionTimeout: CONNECTION_TIMEOUT_MS, greetingTimeout: CONNECTION_TIMEOUT_MS };
}

const socketDeps: SmtpDeps = {
  createTransport: (server) => createTransport(smtpOptions(server)),
  createImapClient: (server) => {
    const client = new ImapFlow(imapOptions(server));
    // A socket that drops after connecting emits "error"; with no listener that would crash the process.
    client.on("error", () => undefined);
    return client;
  },
};

export function createSmtpAdapter(deps: SmtpDeps): Adapter {
  return (context) => ({
    check: () => checkMailbox("la boîte", () => proveMailbox(deps, context)),
    sendEmail: (email) => sendEmail(deps, context, email),
    signalsSince: (since) => signalsSince(deps, context, since),
  });
}

export const smtpAdapter = createSmtpAdapter(socketDeps);

/** Both servers are tried: a mailbox that can send but not be read would never hear its replies. */
async function proveMailbox(deps: SmtpDeps, context: AdapterContext): Promise<string> {
  const { smtp, imap } = serversOf(context.fields);
  await verifySmtp(deps.createTransport(smtp));
  await withImap(deps, imap, async () => undefined);
  return mailboxOf(context.fields).address;
}

async function sendEmail(deps: SmtpDeps, context: AdapterContext, email: OutgoingEmail): Promise<SentMessage> {
  const { smtp, imap } = serversOf(context.fields);
  const mailbox = mailboxOf(context.fields);
  const { raw, messageId } = await composeMessage(mailbox, email, context.now());
  await transmit(deps.createTransport(smtp), { envelope: { from: mailbox.address, to: [email.to] }, raw });
  await keepInSentFolder(deps, imap, raw, context.now());
  return { externalId: messageId, messageId };
}

function serversOf(fields: AdapterContext["fields"]): { smtp: MailServer; imap: MailServer } {
  if ([fields.smtpHost, fields.imapHost].some(isInternalHost)) throw new ProviderError("SMTP", 400, "Indiquez l’adresse publique de votre serveur de messagerie\u00a0: Coldlyne ne joint pas les adresses internes.");
  const credentials = { user: fields.username ?? fields.address, pass: fields.password };
  return {
    smtp: { host: fields.smtpHost, port: Number(fields.smtpPort), ...credentials },
    imap: { host: fields.imapHost, port: Number(fields.imapPort), ...credentials },
  };
}

async function verifySmtp(transport: SmtpTransport): Promise<void> {
  try {
    await transport.verify();
  } catch (error) {
    throw refusalBy("SMTP", error);
  }
}

async function transmit(transport: SmtpTransport, mail: Parameters<SmtpTransport["sendMail"]>[0]): Promise<void> {
  try {
    await transport.sendMail(mail);
  } catch (error) {
    throw refusalBy("SMTP", error);
  }
}

/** An IMAP session for one piece of work, closed afterwards whatever happens. */
async function withImap<T>(deps: SmtpDeps, server: MailServer, work: (session: ImapSession) => Promise<T>): Promise<T> {
  const session = deps.createImapClient(server);
  try {
    await session.connect();
  } catch (error) {
    throw refusalBy("IMAP", error);
  }
  try {
    return await work(session);
  } finally {
    // The work is done or has failed for its own reason: a logout that fails changes neither.
    await session.logout().catch(() => undefined);
  }
}

/**
 * SMTP alone leaves no copy, unlike Gmail and Graph, so the member's Sent folder gets one. Best
 * effort: the mail has left, and failing now would have the scheduler send it a second time.
 */
async function keepInSentFolder(deps: SmtpDeps, server: MailServer, raw: Buffer, date: Date): Promise<void> {
  await withImap(deps, server, async (session) => {
    const sent = (await session.list()).find((folder) => folder.specialUse === SENT_FOLDER);
    if (sent) await session.append(sent.path, raw, ["\\Seen"], date);
  }).catch(() => undefined);
}

async function signalsSince(deps: SmtpDeps, context: AdapterContext, since: Date): Promise<Signal[]> {
  const mailbox = mailboxOf(context.fields);
  const messages = await withImap(deps, serversOf(context.fields).imap, (session) => inboxSince(session, since));
  return oldestFirst(messages.map((message) => signalOf(message, mailbox.address)));
}

/** Opened read-only: reading replies must never change what the member sees as unread. */
async function inboxSince(session: ImapSession, since: Date): Promise<InboxMessage[]> {
  const lock = await session.getMailboxLock("INBOX", { readOnly: true });
  try {
    const uids = await uidsReceivedSince(session, since);
    if (!uids.length) return [];
    const fetched = await session.fetchAll(uids, { uid: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
    return await Promise.all(fetched.flatMap((message) => (message.source ? [readMessage(message.source, { id: `uid:${message.uid}`, receivedAt: receivedAt(message) })] : [])));
  } finally {
    lock.release();
  }
}

/**
 * SEARCH SINCE compares days and disregards time zones: a day earlier is asked, so nothing is
 * missed around midnight, then dates are read and sorted out here before any message comes down.
 */
async function uidsReceivedSince(session: ImapSession, since: Date): Promise<number[]> {
  const candidates = await session.search({ since: new Date(since.getTime() - DAY_MS) }, { uid: true });
  if (!candidates || !candidates.length) return [];
  const dated = await session.fetchAll(candidates, { uid: true, internalDate: true }, { uid: true });
  return dated.filter((message) => receivedAt(message) >= since).map((message) => message.uid);
}

const receivedAt = (message: FetchedMessage) => new Date(message.internalDate ?? 0);

interface ServerRefusal {
  /** nodemailer's error code: EAUTH when the password is refused. */
  code?: string;
  /** The server's SMTP reply. */
  response?: string;
  responseCode?: number;
  /** ImapFlow's flag when the password is refused. */
  authenticationFailed?: boolean;
  message?: string;
}

/** A server's refusal in the member's words, with what it said: that usually names the field to fix. */
function refusalBy(server: "SMTP" | "IMAP", error: unknown): ProviderError {
  const refusal = error as ServerRefusal;
  if (refusal.code === "EAUTH" || refusal.authenticationFailed) {
    return new ProviderError(server, 401, `Le serveur ${server} a refusé les identifiants. Si la boîte a une double authentification, utilisez un mot de passe d’application.`);
  }
  return new ProviderError(server, refusal.responseCode ?? 0, `Le serveur ${server} est injoignable ou a refusé la demande\u00a0: ${refusal.response ?? refusal.message}`);
}
