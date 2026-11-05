import type { OutgoingEmail, SentMessage, Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { bearerJson, requestJson, requestText } from "../http";
import { headersOf, oldestFirst, signalOf, type InboxMessage } from "./classify";
import { checkMailbox, mailboxOf, type Mailbox } from "./mailbox";
import { composeMessage, readMessage } from "./mime";

/**
 * A Microsoft 365 or Outlook mailbox, through Microsoft Graph.
 *
 * Sending as MIME: https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
 * Reading: https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
 * A message's fields: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
 * A message as MIME: https://learn.microsoft.com/en-us/graph/outlook-get-mime-message
 * The inbox's name: https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0
 * Who is signed in: https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0
 */

const API = "https://graph.microsoft.com/v1.0/me";
const PROVIDER = "Microsoft 365";
const LIST_PAGE_SIZE = "50";
const READ_FIELDS = "id,receivedDateTime,subject,from,bodyPreview,internetMessageHeaders";

interface GraphMessage {
  id: string;
  receivedDateTime: string;
  subject?: string | null;
  from?: { emailAddress?: { address?: string | null } | null } | null;
  bodyPreview?: string | null;
  internetMessageHeaders?: { name: string; value: string }[] | null;
}

interface GraphMessageList {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
}

interface GraphUser {
  mail?: string | null;
  userPrincipalName: string;
}

/** The calls made to Graph, each with a fresh token. */
interface GraphClient {
  read<T>(url: string): Promise<T>;
  readMime(messageId: string): Promise<string>;
  sendMime(base64: string): Promise<void>;
}

export const microsoft365Adapter: Adapter = (context) => {
  const bearer = async () => ({ authorization: `Bearer ${await context.accessToken()}` });
  const graph: GraphClient = {
    read: async (url) => requestJson(context.fetch, PROVIDER, url, { headers: bearerJson(await context.accessToken()) }),
    readMime: async (messageId) => requestText(context.fetch, PROVIDER, `${API}/messages/${encodeURIComponent(messageId)}/$value`, { headers: await bearer() }),
    sendMime: async (base64) => {
      await requestText(context.fetch, PROVIDER, `${API}/sendMail`, { method: "POST", headers: { ...(await bearer()), "content-type": "text/plain" }, body: base64 });
    },
  };

  return {
    check: () => checkMailbox(PROVIDER, () => proveMailbox(graph)),
    sendEmail: async (email) => sendEmail(graph, mailboxOf(context.fields), email, context.now()),
    signalsSince: async (since) => signalsSince(graph, mailboxOf(context.fields), since),
  };
};

/** Signing in proves little: an account can exist with no mailbox, so the inbox is opened too. */
async function proveMailbox(graph: GraphClient): Promise<string> {
  const user = await graph.read<GraphUser>(`${API}?$select=mail,userPrincipalName`);
  await graph.read(`${API}/mailFolders/inbox?$select=id`);
  return user.mail ?? user.userPrincipalName;
}

/**
 * As MIME, because Graph's JSON only takes custom headers named "x-…", which would lose
 * List-Unsubscribe. Graph answers 202 with no body, so the message's only id is the one given here.
 */
async function sendEmail(graph: GraphClient, mailbox: Mailbox, email: OutgoingEmail, date: Date): Promise<SentMessage> {
  const { raw, messageId } = await composeMessage(mailbox, email, date);
  await graph.sendMime(raw.toString("base64"));
  return { externalId: messageId, messageId };
}

async function signalsSince(graph: GraphClient, mailbox: Mailbox, since: Date): Promise<Signal[]> {
  const signals: (Signal | null)[] = [];
  let url: string | undefined = firstPageUrl(since);
  while (url) {
    const page: GraphMessageList = await graph.read(url);
    for (const message of page.value ?? []) signals.push(await signalFor(graph, inboxMessage(message), mailbox));
    url = page["@odata.nextLink"];
  }
  return oldestFirst(signals);
}

/** Percent-encoded by hand: Graph's examples write `$` as is and a space as %20, never `+`. */
function firstPageUrl(since: Date): string {
  const query = {
    $filter: `receivedDateTime ge ${since.toISOString().replace(/\.\d+Z$/, "Z")}`,
    $orderby: "receivedDateTime asc",
    $select: READ_FIELDS,
    $top: LIST_PAGE_SIZE,
  };
  const encoded = Object.entries(query).map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  return `${API}/mailFolders/inbox/messages?${encoded.join("&")}`;
}

/** Exchange's own bounces name their recipient only in the delivery report, which Graph has only in the MIME. */
async function signalFor(graph: GraphClient, message: InboxMessage, mailbox: Mailbox): Promise<Signal | null> {
  const signal = signalOf(message, mailbox.address);
  if (signal?.type !== "bounced" || signal.address) return signal;
  const full = await readMessage(await graph.readMime(message.id), message);
  return signalOf({ ...full, id: message.id }, mailbox.address);
}

function inboxMessage(message: GraphMessage): InboxMessage {
  return {
    id: message.id,
    receivedAt: new Date(message.receivedDateTime),
    from: message.from?.emailAddress?.address ?? null,
    subject: message.subject ?? "",
    headers: headersOf(message.internetMessageHeaders ?? []),
    text: message.bodyPreview ?? "",
  };
}
