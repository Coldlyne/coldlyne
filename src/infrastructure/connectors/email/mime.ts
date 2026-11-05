import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { OutgoingEmail } from "@/application/ports";
import { headersOf, type InboxMessage } from "./classify";
import type { Mailbox } from "./mailbox";

/**
 * Email as bytes, both ways: the RFC 5322 message every provider is handed, and a raw message read
 * back into what the classifier needs.
 *
 * Composing: https://nodemailer.com/extras/mailcomposer and https://nodemailer.com/message
 * Parsing: https://nodemailer.com/extras/mailparser
 */

/** One bare address: nothing a mail library would read as a list, a group or a second header. */
const ONE_ADDRESS = /^[^\s@,;:<>()"[\]\\]+@[^\s@,;:<>()"[\]\\]+$/;

export interface ComposedMessage {
  raw: Buffer;
  /** The Message-ID header, which a reply's In-Reply-To names. */
  messageId: string;
}

/**
 * The message as the prospect will receive it. The recipient comes from public pages and the
 * assistant sends alone: a malformed one is refused here, or it could reach someone else.
 */
export async function composeMessage(mailbox: Mailbox, email: OutgoingEmail, date: Date): Promise<ComposedMessage> {
  if (!ONE_ADDRESS.test(email.to)) throw new Error(`Cette adresse de destinataire n’est pas valable\u00a0: ${email.to}`);
  const messageId = `<${randomUUID()}@${mailbox.address.split("@").pop()}>`;
  const composer = new MailComposer({
    from: mailbox.name ? { name: mailbox.name, address: mailbox.address } : mailbox.address,
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
    date,
    messageId,
    inReplyTo: email.inReplyTo,
    references: email.references?.length ? email.references : email.inReplyTo,
    headers: email.headers,
    newline: "win",
  });
  return { raw: await composer.compile().build(), messageId };
}

/** A raw message as the classifier reads it; `known` says what only the mailbox knows. */
export async function readMessage(raw: Buffer | string, known: Pick<InboxMessage, "id" | "receivedAt">): Promise<InboxMessage> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  return {
    id: mail.messageId ?? known.id,
    receivedAt: known.receivedAt,
    from: mail.from?.value.find((entry) => entry.address)?.address ?? null,
    subject: mail.subject ?? "",
    headers: headersOf(mail.headerLines.map(({ key, line }) => ({ name: key, value: line.slice(line.indexOf(":") + 1) }))),
    text: mail.text ?? "",
  };
}
