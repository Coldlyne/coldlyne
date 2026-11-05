import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { CONNECTORS } from "@/domain/connectors";
import { emailAdapters } from "@/infrastructure/connectors/email";
import { gmailAdapter } from "@/infrastructure/connectors/email/gmail";
import { microsoft365Adapter } from "@/infrastructure/connectors/email/microsoft365";
import { composeMessage } from "@/infrastructure/connectors/email/mime";
import { createSmtpAdapter, imapOptions, smtpOptions, type FetchedMessage, type ImapSession, type MailServer, type SmtpDeps, type SmtpTransport } from "@/infrastructure/connectors/email/smtp";
import { ProviderError } from "@/infrastructure/connectors/http";
import { COLD_EMAIL, EXCHANGE_NDR_MIME, FOLLOW_UP, GMAIL_DSN, headerBlockOf, OUTLOOK_AUTO_REPLY_HEADERS } from "../support/email";
import { adapterContext, fakeFetch } from "../support/fetch";

const MAILBOX = { address: "marie@northwind.fr", displayName: "Marie, de Northwind" };
const SINCE = new Date("2026-11-04T08:00:00Z");
const GENERATED_MESSAGE_ID = /^<[0-9a-f-]{36}@northwind\.fr>$/;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

const base64url = (text: string) => Buffer.from(text).toString("base64url");

describe("the email connectors", () => {
  it("have an adapter for each kind the catalogue lists", () => {
    const kinds = CONNECTORS.filter((connector) => connector.category === "email").map((connector) => connector.kind);

    expect(Object.keys(emailAdapters).sort()).toEqual([...kinds].sort());
  });
});

describe("the message every provider is handed", () => {
  it("says who writes, to whom, when, with its own id and the unsubscribe headers", async () => {
    const { raw, messageId } = await composeMessage({ address: "marie@northwind.fr", name: "Marie, de Northwind" }, COLD_EMAIL, new Date("2026-11-04T09:00:00Z"));

    const headers = headerBlockOf(raw);
    expect(messageId).toMatch(GENERATED_MESSAGE_ID);
    expect(headers).toContain('From: "Marie, de Northwind" <marie@northwind.fr>');
    expect(headers).toContain("To: jeanne@acme.fr");
    expect(headers).toContain("Subject: Votre holding, une question");
    expect(headers).toContain("Date: Wed, 04 Nov 2026 09:00:00 +0000");
    expect(headers).toContain(`Message-ID: ${messageId}`);
    expect(headers).toContain("List-Unsubscribe: <https://coldlyne.test/unsubscribe/abc123>, <mailto:stop@northwind.fr?subject=stop>");
    expect(headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(headers).not.toContain("In-Reply-To");
  });

  it("carries both the text and the html", async () => {
    const { raw } = await composeMessage({ address: "marie@northwind.fr" }, COLD_EMAIL, new Date());

    const parsed = await simpleParser(raw);
    expect(parsed.text).toContain("Une question sur votre holding.");
    expect(parsed.html).toContain("<p>Bonjour Jeanne,</p>");
  });

  it("is text alone when there is no html", async () => {
    const { raw } = await composeMessage({ address: "marie@northwind.fr" }, { ...COLD_EMAIL, html: undefined }, new Date());

    expect(headerBlockOf(raw)).toContain("Content-Type: text/plain");
  });

  it("stays in the prospect's thread on a follow-up", async () => {
    const { raw } = await composeMessage({ address: "marie@northwind.fr" }, FOLLOW_UP, new Date());

    expect(headerBlockOf(raw)).toContain("In-Reply-To: <first-step@northwind.fr>");
    expect(headerBlockOf(raw)).toContain("References: <first-step@northwind.fr>");
  });

  it("names what it answers in References when the step gave none", async () => {
    const { raw } = await composeMessage({ address: "marie@northwind.fr" }, { ...FOLLOW_UP, references: [] }, new Date());

    expect(headerBlockOf(raw)).toContain("References: <first-step@northwind.fr>");
  });

  it("can't be given another recipient through its subject or headers", async () => {
    const { raw } = await composeMessage({ address: "marie@northwind.fr" }, { ...COLD_EMAIL, subject: "Bonjour\r\nBcc: other@evil.test", headers: { "X-Step": "1\r\nBcc: other@evil.test" } }, new Date());

    expect(raw.toString().split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
  });

  it.each(["jeanne@acme.fr, other@evil.test", "jeanne@acme.fr\r\nBcc: other@evil.test", "Jeanne <jeanne@acme.fr>", "jeanne", ""])("refuses to write to %j, which isn't one address", async (to) => {
    await expect(composeMessage({ address: "marie@northwind.fr" }, { ...COLD_EMAIL, to }, new Date())).rejects.toThrow("Cette adresse de destinataire n’est pas valable\u00a0:");
  });
});

describe("Gmail", () => {
  describe("checking the connection", () => {
    it("names the mailbox the token opens, in lowercase", async () => {
      const { fetch, calls } = fakeFetch([{ match: `GET ${GMAIL}/profile`, json: { emailAddress: "Marie@northwind.fr", messagesTotal: 12 } }]);

      const check = await gmailAdapter(adapterContext({}, fetch)).check();

      expect(check).toEqual({ ok: true, detail: "boîte marie@northwind.fr", label: "marie@northwind.fr" });
      expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
    });

    it("says why when Google refuses the token", async () => {
      const { fetch } = fakeFetch([{ match: `GET ${GMAIL}/profile`, status: 401, json: { error: { code: 401, message: "Invalid Credentials" } } }]);

      const check = await gmailAdapter(adapterContext({}, fetch)).check();

      expect(check.ok).toBe(false);
      expect(check.detail).toContain("Gmail a refusé les identifiants");
      expect(check.detail).toContain("Invalid Credentials");
    });

    it("says why when the token can't be had at all", async () => {
      const { fetch } = fakeFetch([]);
      const context = adapterContext({}, fetch, {
        accessToken: async () => {
          throw new Error("jeton révoqué");
        },
      });

      expect(await gmailAdapter(context).check()).toEqual({ ok: false, detail: "Impossible de vérifier Gmail\u00a0: jeton révoqué" });
    });
  });

  describe("sending", () => {
    it("posts the raw message, base64url, and keeps Gmail's ids with the Message-ID it generated", async () => {
      const { fetch, calls } = fakeFetch([{ match: `POST ${GMAIL}/messages/send`, json: { id: "18f0a", threadId: "18e00", labelIds: ["SENT"] } }]);

      const sent = await gmailAdapter(adapterContext(MAILBOX, fetch)).sendEmail!(COLD_EMAIL);

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${GMAIL}/messages/send`);
      expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
      expect(calls[0].headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(calls[0].body) as { raw: string; threadId?: string };
      expect(body.raw).not.toMatch(/[+/=]/);
      expect(body.threadId).toBeUndefined();
      const headers = headerBlockOf(Buffer.from(body.raw, "base64url"));
      expect(headers).toContain('From: "Marie, de Northwind" <marie@northwind.fr>');
      expect(headers).toContain("To: jeanne@acme.fr");
      expect(headers).toContain("Date: Wed, 04 Nov 2026 09:00:00 +0000");
      expect(headers).toContain("List-Unsubscribe: <https://coldlyne.test/unsubscribe/abc123>, <mailto:stop@northwind.fr?subject=stop>");
      expect(headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
      expect(sent.externalId).toBe("18f0a");
      expect(sent.threadId).toBe("18e00");
      expect(sent.messageId).toMatch(GENERATED_MESSAGE_ID);
      expect(headers).toContain(`Message-ID: ${sent.messageId}`);
    });

    it("finds the thread of what a follow-up answers, and sends in it with the threading headers", async () => {
      const { fetch, calls } = fakeFetch([
        { match: `GET ${GMAIL}/messages?`, json: { messages: [{ id: "18f0a", threadId: "18e00" }] } },
        { match: `POST ${GMAIL}/messages/send`, json: { id: "18f0b", threadId: "18e00" } },
      ]);

      await gmailAdapter(adapterContext(MAILBOX, fetch)).sendEmail!(FOLLOW_UP);

      const lookup = new URL(calls[0].url);
      expect(lookup.searchParams.get("q")).toBe("rfc822msgid:first-step@northwind.fr");
      expect(lookup.searchParams.get("maxResults")).toBe("1");
      const body = JSON.parse(calls[1].body) as { raw: string; threadId: string };
      expect(body.threadId).toBe("18e00");
      const headers = headerBlockOf(Buffer.from(body.raw, "base64url"));
      expect(headers).toContain("In-Reply-To: <first-step@northwind.fr>");
      expect(headers).toContain("References: <first-step@northwind.fr>");
    });

    it("still sends a follow-up whose thread can't be found, on its headers alone", async () => {
      const { fetch, calls } = fakeFetch([
        { match: `GET ${GMAIL}/messages?`, json: { resultSizeEstimate: 0 } },
        { match: `POST ${GMAIL}/messages/send`, json: { id: "18f0b", threadId: "18f0b" } },
      ]);

      await gmailAdapter(adapterContext(MAILBOX, fetch)).sendEmail!(FOLLOW_UP);

      expect((JSON.parse(calls[1].body) as { threadId?: string }).threadId).toBeUndefined();
    });

    it("throws the provider's refusal", async () => {
      const { fetch } = fakeFetch([{ match: `POST ${GMAIL}/messages/send`, status: 403, json: { error: { message: "Insufficient Permission" } } }]);

      await expect(gmailAdapter(adapterContext(MAILBOX, fetch)).sendEmail!(COLD_EMAIL)).rejects.toBeInstanceOf(ProviderError);
    });

    it("asks for a reconnection, as a rejected promise, when the mailbox's address was never saved", async () => {
      const { fetch } = fakeFetch([]);

      await expect(gmailAdapter(adapterContext({}, fetch)).signalsSince!(SINCE)).rejects.toThrow("L’adresse de cette boîte manque");
      await expect(microsoft365Adapter(adapterContext({}, fetch)).sendEmail!(COLD_EMAIL)).rejects.toThrow("L’adresse de cette boîte manque");
      await expect(gmailAdapter(adapterContext({}, fetch)).sendEmail!(COLD_EMAIL)).rejects.toThrow("L’adresse de cette boîte manque\u00a0: reconnectez-la.");
    });
  });

  describe("reading what came back", () => {
    const message = (id: string, internalDate: string, headers: Record<string, string>, payload: object) => ({
      id,
      threadId: "t",
      internalDate,
      snippet: "",
      payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })), ...payload },
    });

    it("searches the inbox since then in seconds, without the mailbox's own mail, page after page", async () => {
      const seconds = SINCE.getTime() / 1000;
      const firstPage = `${GMAIL}/messages?q=after%3A${seconds}+-from%3Ame&labelIds=INBOX&maxResults=100`;
      const { fetch, calls } = fakeFetch([
        { match: `GET ${firstPage}&pageToken=p2`, json: { messages: [{ id: "m2", threadId: "t" }] } },
        { match: `GET ${firstPage}`, json: { messages: [{ id: "m1", threadId: "t" }], nextPageToken: "p2" } },
        { match: `GET ${GMAIL}/messages/m1`, json: message("m1", "1793790000000", { From: "Jeanne <jeanne@acme.fr>", Subject: "Re: Votre holding" }, {}) },
        { match: `GET ${GMAIL}/messages/m2`, json: message("m2", "1793786400000", { From: "paul@acme.fr", Subject: "Re: Votre holding" }, {}) },
      ]);

      const signals = await gmailAdapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(calls.map((call) => call.url)).toEqual([firstPage, `${firstPage}&pageToken=p2`, `${GMAIL}/messages/m1?format=full`, `${GMAIL}/messages/m2?format=full`]);
      expect(signals.map((signal) => signal.externalId)).toEqual(["m2", "m1"]);
      expect(signals[0].at).toEqual(new Date(1793786400000));
    });

    it("reads a reply's headers and the text of its parts", async () => {
      const reply = message(
        "m1",
        "1793790000000",
        { From: '"Dupont, Jeanne" <Jeanne@acme.fr>', Subject: "Re: Votre holding", "In-Reply-To": "<first-step@northwind.fr>" },
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: base64url("Oui, parlons-en jeudi.\r\n") } },
            { mimeType: "text/html", body: { data: base64url("<p>Oui, parlons-en jeudi.</p>") } },
          ],
        },
      );
      const { fetch } = fakeFetch([
        { match: `GET ${GMAIL}/messages?`, json: { messages: [{ id: "m1", threadId: "t" }] } },
        { match: `GET ${GMAIL}/messages/m1`, json: reply },
      ]);

      const [signal] = await gmailAdapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(signal).toMatchObject({ type: "replied", address: "jeanne@acme.fr", inReplyTo: "<first-step@northwind.fr>", detail: "Re: Votre holding\nOui, parlons-en jeudi." });
    });

    it("falls back on the snippet, unescaped, for a message with no text part", async () => {
      const htmlOnly = { ...message("m1", "1793790000000", { From: "jeanne@acme.fr", Subject: "Re" }, { mimeType: "text/html" }), snippet: "C&#39;est non, merci &amp; bonne journ&eacute;e" };
      const { fetch } = fakeFetch([
        { match: `GET ${GMAIL}/messages?`, json: { messages: [{ id: "m1", threadId: "t" }] } },
        { match: `GET ${GMAIL}/messages/m1`, json: htmlOnly },
      ]);

      const [signal] = await gmailAdapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(signal.detail).toBe("Re\nC'est non, merci & bonne journée");
    });

    it("names the failed recipient of Gmail's own report, from its header and from its report part", async () => {
      const report = (headers: Record<string, string>, id: string) =>
        message(id, "1793790000000", { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Failure)", "Content-Type": 'multipart/report; boundary="b"; report-type=delivery-status', ...headers }, {
          mimeType: "multipart/report",
          parts: [
            { mimeType: "text/plain", body: { data: base64url("** Address not found **") } },
            { mimeType: "message/delivery-status", body: { data: base64url("Final-Recipient: rfc822; paul@acme.fr\r\nAction: failed\r\n") } },
          ],
        });
      const { fetch } = fakeFetch([
        { match: `GET ${GMAIL}/messages?`, json: { messages: [{ id: "m1", threadId: "t" }, { id: "m2", threadId: "t" }] } },
        { match: `GET ${GMAIL}/messages/m1`, json: report({ "X-Failed-Recipients": "jeanne@acme.fr" }, "m1") },
        { match: `GET ${GMAIL}/messages/m2`, json: report({}, "m2") },
      ]);

      const signals = await gmailAdapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(signals.map(({ type, address }) => [type, address])).toEqual([
        ["bounced", "jeanne@acme.fr"],
        ["bounced", "paul@acme.fr"],
      ]);
    });
  });
});

describe("Microsoft 365", () => {
  const INBOX_PAGE =
    `${GRAPH}/mailFolders/inbox/messages?$filter=receivedDateTime%20ge%202026-11-04T08%3A00%3A00Z&$orderby=receivedDateTime%20asc` +
    "&$select=id%2CreceivedDateTime%2Csubject%2Cfrom%2CbodyPreview%2CinternetMessageHeaders&$top=50";
  const from = (address: string) => ({ emailAddress: { name: "Quelqu'un", address } });

  describe("checking the connection", () => {
    it("names the signed-in mailbox after opening its inbox", async () => {
      const { fetch, calls } = fakeFetch([
        { match: `GET ${GRAPH}?$select=mail,userPrincipalName`, json: { mail: "Marie@northwind.fr", userPrincipalName: "marie@northwind.onmicrosoft.com" } },
        { match: `GET ${GRAPH}/mailFolders/inbox?$select=id`, json: { id: "AAMk" } },
      ]);

      const check = await microsoft365Adapter(adapterContext({}, fetch)).check();

      expect(check).toEqual({ ok: true, detail: "boîte marie@northwind.fr", label: "marie@northwind.fr" });
      expect(calls.map((call) => call.headers.get("authorization"))).toEqual(["Bearer test-access-token", "Bearer test-access-token"]);
    });

    it("falls back on the user principal name for an account with no mail property", async () => {
      const { fetch } = fakeFetch([
        { match: `GET ${GRAPH}?$select=mail,userPrincipalName`, json: { mail: null, userPrincipalName: "marie@outlook.com" } },
        { match: `GET ${GRAPH}/mailFolders/inbox?$select=id`, json: { id: "AAMk" } },
      ]);

      expect((await microsoft365Adapter(adapterContext({}, fetch)).check()).label).toBe("marie@outlook.com");
    });

    it("says why when Microsoft refuses the token", async () => {
      const { fetch } = fakeFetch([{ match: `GET ${GRAPH}?$select=mail,userPrincipalName`, status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } } }]);

      const check = await microsoft365Adapter(adapterContext({}, fetch)).check();

      expect(check.ok).toBe(false);
      expect(check.detail).toContain("Microsoft 365 a refusé les identifiants");
      expect(check.detail).toContain("Access token has expired.");
    });

    it("says why when the account has no mailbox", async () => {
      const { fetch } = fakeFetch([
        { match: `GET ${GRAPH}?$select=mail,userPrincipalName`, json: { mail: null, userPrincipalName: "marie@northwind.fr" } },
        { match: `GET ${GRAPH}/mailFolders/inbox?$select=id`, status: 404, json: { error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } } },
      ]);

      const check = await microsoft365Adapter(adapterContext({}, fetch)).check();

      expect(check.ok).toBe(false);
      expect(check.detail).toContain("The mailbox is either inactive");
    });
  });

  describe("sending", () => {
    it("posts the MIME in base64 as text/plain, and takes the Message-ID as its id since Graph returns none", async () => {
      const { fetch, calls } = fakeFetch([{ match: `POST ${GRAPH}/sendMail`, status: 202 }]);

      const sent = await microsoft365Adapter(adapterContext(MAILBOX, fetch)).sendEmail!(FOLLOW_UP);

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${GRAPH}/sendMail`);
      expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
      expect(calls[0].headers.get("content-type")).toBe("text/plain");
      expect(calls[0].body).toMatch(/^[A-Za-z0-9+/]+=*$/);
      const headers = headerBlockOf(Buffer.from(calls[0].body, "base64"));
      expect(headers).toContain('From: "Marie, de Northwind" <marie@northwind.fr>');
      expect(headers).toContain("List-Unsubscribe: <https://coldlyne.test/unsubscribe/abc123>, <mailto:stop@northwind.fr?subject=stop>");
      expect(headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
      expect(headers).toContain("In-Reply-To: <first-step@northwind.fr>");
      expect(sent.messageId).toMatch(GENERATED_MESSAGE_ID);
      expect(sent.externalId).toBe(sent.messageId);
      expect(headers).toContain(`Message-ID: ${sent.messageId}`);
    });

    it("throws the provider's refusal", async () => {
      const { fetch } = fakeFetch([{ match: `POST ${GRAPH}/sendMail`, status: 400, json: { error: { code: "ErrorMimeContentInvalidBase64String", message: "Invalid base64 string for MIME content." } } }]);

      await expect(microsoft365Adapter(adapterContext(MAILBOX, fetch)).sendEmail!(COLD_EMAIL)).rejects.toThrow("Invalid base64 string for MIME content.");
    });
  });

  describe("reading what came back", () => {
    it("asks the inbox for what arrived since then, oldest first, page after page", async () => {
      const nextLink = `${GRAPH}/mailFolders/inbox/messages?$skip=50`;
      const { fetch, calls } = fakeFetch([
        { match: `GET ${nextLink}`, json: { value: [{ id: "m2", receivedDateTime: "2026-11-04T09:30:00Z", subject: "Re: B", from: from("paul@acme.fr"), bodyPreview: "Non merci." }] } },
        { match: `GET ${INBOX_PAGE}`, json: { value: [{ id: "m1", receivedDateTime: "2026-11-04T09:00:00Z", subject: "Re: A", from: from("Jeanne@acme.fr"), bodyPreview: "Oui.", internetMessageHeaders: [{ name: "In-Reply-To", value: "<first-step@northwind.fr>" }] }], "@odata.nextLink": nextLink } },
      ]);

      const signals = await microsoft365Adapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(calls.map((call) => call.url)).toEqual([INBOX_PAGE, nextLink]);
      expect(signals).toEqual([
        { type: "replied", channel: "email", externalId: "m1", address: "jeanne@acme.fr", at: new Date("2026-11-04T09:00:00Z"), detail: "Re: A\nOui.", inReplyTo: "<first-step@northwind.fr>" },
        { type: "replied", channel: "email", externalId: "m2", address: "paul@acme.fr", at: new Date("2026-11-04T09:30:00Z"), detail: "Re: B\nNon merci." },
      ]);
    });

    it("recognizes a French Outlook out-of-office, and leaves out the mailbox's own mail", async () => {
      const { fetch } = fakeFetch([
        {
          match: `GET ${INBOX_PAGE}`,
          json: {
            value: [
              { id: "m1", receivedDateTime: "2026-11-04T09:12:41Z", subject: "Réponse automatique\u00a0: Votre holding", from: from("Jeanne@acme.fr"), bodyPreview: "Je suis absente jusqu'au 12 novembre.", internetMessageHeaders: OUTLOOK_AUTO_REPLY_HEADERS },
              { id: "m2", receivedDateTime: "2026-11-04T09:20:00Z", subject: "Note", from: from("Marie@northwind.fr"), bodyPreview: "À moi-même." },
            ],
          },
        },
      ]);

      const signals = await microsoft365Adapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ type: "auto_reply", address: "jeanne@acme.fr", inReplyTo: "<first-step@northwind.fr>" });
    });

    it("reads a bounce's recipient from its MIME when Graph's fields don't name it, keeping Graph's id", async () => {
      const { fetch, calls } = fakeFetch([
        { match: `GET ${INBOX_PAGE}`, json: { value: [{ id: "AAMk/ndr=", receivedDateTime: "2026-11-04T09:05:00Z", subject: "Non remis\u00a0: Votre holding", from: from("postmaster@northwind.onmicrosoft.com"), bodyPreview: "Votre message n'a pas pu être remis." }] } },
        { match: `GET ${GRAPH}/messages/AAMk%2Fndr%3D/$value`, text: EXCHANGE_NDR_MIME },
      ]);

      const signals = await microsoft365Adapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(calls[1].headers.get("authorization")).toBe("Bearer test-access-token");
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ type: "bounced", externalId: "AAMk/ndr=", address: "jeanne@acme.fr", at: new Date("2026-11-04T09:05:00Z"), inReplyTo: "<first-step@northwind.fr>" });
    });

    it("doesn't fetch the MIME of a bounce whose headers already name the recipient", async () => {
      const { fetch, calls } = fakeFetch([
        { match: `GET ${INBOX_PAGE}`, json: { value: [{ id: "m1", receivedDateTime: "2026-11-04T09:05:00Z", subject: "Undeliverable", from: from("mailer-daemon@acme.fr"), internetMessageHeaders: [{ name: "X-Failed-Recipients", value: "jeanne@acme.fr" }] }] } },
      ]);

      const signals = await microsoft365Adapter(adapterContext(MAILBOX, fetch)).signalsSince!(SINCE);

      expect(calls).toHaveLength(1);
      expect(signals[0]).toMatchObject({ type: "bounced", address: "jeanne@acme.fr" });
    });
  });
});

describe("SMTP and IMAP", () => {
  const FIELDS = { ...MAILBOX, smtpHost: "ssl0.ovh.net", smtpPort: "465", imapHost: "imap.ovh.net", imapPort: "993", password: "secret" };
  const SENT_FOLDERS = [
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "INBOX.Envoyés", specialUse: "\\Sent" },
  ];

  /** Stand-ins for both servers, which remember what they were asked. */
  function fakeServers(options: { folders?: { path: string; specialUse?: string }[]; dated?: FetchedMessage[]; downloaded?: FetchedMessage[]; transport?: Partial<SmtpTransport>; session?: Partial<ImapSession> } = {}) {
    const mails: Parameters<SmtpTransport["sendMail"]>[0][] = [];
    const servers: { smtp: MailServer[]; imap: MailServer[] } = { smtp: [], imap: [] };
    const imap = { appended: [] as { path: string; content: Buffer; flags: string[]; date: Date }[], locks: [] as { path: string; readOnly: boolean }[], searches: [] as Date[], fetchedUids: [] as number[][], sourceLimits: [] as number[], released: 0, loggedOut: 0 };

    const session: ImapSession = {
      connect: async () => undefined,
      logout: async () => {
        imap.loggedOut += 1;
      },
      list: async () => options.folders ?? SENT_FOLDERS,
      append: async (path, content, flags, date) => {
        imap.appended.push({ path, content, flags, date });
      },
      getMailboxLock: async (path, lockOptions) => {
        imap.locks.push({ path, readOnly: lockOptions.readOnly });
        return {
          release: () => {
            imap.released += 1;
          },
        };
      },
      search: async (query) => {
        imap.searches.push(query.since);
        return (options.dated ?? []).map((message) => message.uid);
      },
      fetchAll: async (range, query) => {
        if (!query.source) return options.dated ?? [];
        imap.fetchedUids.push(range);
        imap.sourceLimits.push(query.source.maxLength);
        return options.downloaded ?? [];
      },
      ...options.session,
    };
    const transport: SmtpTransport = {
      verify: async () => true,
      sendMail: async (mail) => {
        mails.push(mail);
      },
      ...options.transport,
    };
    const deps: SmtpDeps = {
      createTransport: (server) => {
        servers.smtp.push(server);
        return transport;
      },
      createImapClient: (server) => {
        servers.imap.push(server);
        return session;
      },
    };
    return { adapter: createSmtpAdapter(deps), mails, servers, imap };
  }

  const context = (fields: Record<string, string> = FIELDS) => adapterContext(fields, fakeFetch([]).fetch);

  describe("the sockets' options", () => {
    const server = { host: "mail.northwind.fr", user: "marie@northwind.fr", pass: "secret" };

    it("are secure from the first byte on the implicit TLS ports", () => {
      expect(smtpOptions({ ...server, port: 465 })).toMatchObject({ host: "mail.northwind.fr", port: 465, secure: true, requireTLS: false, auth: { user: "marie@northwind.fr", pass: "secret" } });
      expect(imapOptions({ ...server, port: 993 })).toMatchObject({ host: "mail.northwind.fr", port: 993, secure: true, doSTARTTLS: undefined, logger: false, auth: { user: "marie@northwind.fr", pass: "secret" } });
    });

    it("require STARTTLS anywhere else, so a password never travels in clear", () => {
      expect(smtpOptions({ ...server, port: 587 })).toMatchObject({ secure: false, requireTLS: true });
      expect(imapOptions({ ...server, port: 143 })).toMatchObject({ secure: false, doSTARTTLS: true });
    });
  });

  describe("checking the connection", () => {
    it("tries both servers with the address as login, and names the mailbox", async () => {
      const { adapter, servers, imap } = fakeServers();

      const check = await adapter(context()).check();

      expect(check).toEqual({ ok: true, detail: "boîte marie@northwind.fr", label: "marie@northwind.fr" });
      expect(servers.smtp).toEqual([{ host: "ssl0.ovh.net", port: 465, user: "marie@northwind.fr", pass: "secret" }]);
      expect(servers.imap).toEqual([{ host: "imap.ovh.net", port: 993, user: "marie@northwind.fr", pass: "secret" }]);
      expect(imap.loggedOut).toBe(1);
    });

    it("signs in with the login the member typed, when it isn't the address", async () => {
      const { adapter, servers } = fakeServers();

      await adapter(context({ ...FIELDS, username: "marie" })).check();

      expect(servers.smtp[0].user).toBe("marie");
      expect(servers.imap[0].user).toBe("marie");
    });

    it("says when the SMTP server refuses the password, and about app passwords", async () => {
      const refused = Object.assign(new Error("Invalid login: 535 5.7.8 Error"), { code: "EAUTH", responseCode: 535 });
      const { adapter, servers } = fakeServers({ transport: { verify: () => Promise.reject(refused) } });

      const check = await adapter(context()).check();

      expect(check).toEqual({ ok: false, detail: "Le serveur SMTP a refusé les identifiants. Si la boîte a une double authentification, utilisez un mot de passe d’application." });
      expect(servers.imap).toEqual([]);
    });

    it("says when the IMAP server refuses the password", async () => {
      const refused = Object.assign(new Error("Command failed"), { authenticationFailed: true });
      const { adapter } = fakeServers({ session: { connect: () => Promise.reject(refused) } });

      expect((await adapter(context()).check()).detail).toContain("Le serveur IMAP a refusé les identifiants.");
    });

    it("says what happened when a server can't be reached", async () => {
      const unreachable = Object.assign(new Error("getaddrinfo ENOTFOUND ssl0.ovh.net"), { code: "EDNS" });
      const { adapter } = fakeServers({ transport: { verify: () => Promise.reject(unreachable) } });

      expect(await adapter(context()).check()).toEqual({ ok: false, detail: "Le serveur SMTP est injoignable ou a refusé la demande\u00a0: getaddrinfo ENOTFOUND ssl0.ovh.net" });
    });
  });

  describe("sending", () => {
    it.each(["localhost", "127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "2130706433", "mail.internal"])("won't reach %s: a mail server must be public", async (smtpHost) => {
      const { adapter, servers } = fakeServers();
      const check = await adapter(context({ ...FIELDS, smtpHost })).check();
      expect(check).toMatchObject({ ok: false, detail: expect.stringContaining("adresse publique") });
      expect(servers.smtp).toEqual([]);
    });

    it("hands the SMTP server the built message with its envelope, and returns the Message-ID", async () => {
      const { adapter, mails } = fakeServers();

      const sent = await adapter(context()).sendEmail!(FOLLOW_UP);

      expect(mails).toHaveLength(1);
      expect(mails[0].envelope).toEqual({ from: "marie@northwind.fr", to: ["jeanne@acme.fr"] });
      const headers = headerBlockOf(mails[0].raw);
      expect(headers).toContain('From: "Marie, de Northwind" <marie@northwind.fr>');
      expect(headers).toContain("List-Unsubscribe: <https://coldlyne.test/unsubscribe/abc123>, <mailto:stop@northwind.fr?subject=stop>");
      expect(headers).toContain("In-Reply-To: <first-step@northwind.fr>");
      expect(sent.messageId).toMatch(GENERATED_MESSAGE_ID);
      expect(sent.externalId).toBe(sent.messageId);
      expect(headers).toContain(`Message-ID: ${sent.messageId}`);
    });

    it("files the very same message in the Sent folder, marked as read", async () => {
      const { adapter, mails, imap } = fakeServers();

      await adapter(context()).sendEmail!(COLD_EMAIL);

      expect(imap.appended).toEqual([{ path: "INBOX.Envoyés", content: mails[0].raw, flags: ["\\Seen"], date: new Date("2026-11-04T09:00:00Z") }]);
      expect(imap.loggedOut).toBe(1);
    });

    it("files nothing when the server has no Sent folder", async () => {
      const { adapter, imap } = fakeServers({ folders: [{ path: "INBOX" }] });

      await adapter(context()).sendEmail!(COLD_EMAIL);

      expect(imap.appended).toEqual([]);
    });

    it("still reports the send when the copy can't be filed, or the scheduler would send it twice", async () => {
      const { adapter, mails } = fakeServers({ session: { connect: () => Promise.reject(new Error("IMAP down")) } });

      const sent = await adapter(context()).sendEmail!(COLD_EMAIL);

      expect(mails).toHaveLength(1);
      expect(sent.messageId).toMatch(GENERATED_MESSAGE_ID);
    });

    it("throws what the SMTP server said when it refuses the mail, and files no copy", async () => {
      const rejected = Object.assign(new Error("Can't send mail"), { code: "EENVELOPE", responseCode: 550, response: "550 5.7.1 Relaying denied" });
      const { adapter, imap } = fakeServers({ transport: { sendMail: () => Promise.reject(rejected) } });

      const failure = adapter(context()).sendEmail!(COLD_EMAIL);

      await expect(failure).rejects.toMatchObject({ name: "ProviderError", status: 550, message: "Le serveur SMTP est injoignable ou a refusé la demande\u00a0: 550 5.7.1 Relaying denied" });
      expect(imap.appended).toEqual([]);
    });
  });

  describe("reading what came back", () => {
    const REPLY = ["From: Jeanne <Jeanne@acme.fr>", "To: marie@northwind.fr", "Subject: Re: Votre holding", "Message-ID: <reply-1@acme.fr>", "In-Reply-To: <first-step@northwind.fr>", "", "Oui, parlons-en jeudi.", ""].join("\r\n");
    const OWN_MAIL = ["From: Marie <marie@northwind.fr>", "To: marie@northwind.fr", "Subject: Note", "", "À moi-même.", ""].join("\r\n");
    const NO_ID = ["From: paul@acme.fr", "Subject: Bonjour", "", "Sans identifiant.", ""].join("\r\n");

    it("asks for a day earlier, since SEARCH SINCE compares days, and downloads only what arrived since then", async () => {
      const { adapter, imap } = fakeServers({
        dated: [
          { uid: 7, internalDate: new Date("2026-11-04T07:59:59Z") },
          { uid: 8, internalDate: new Date("2026-11-04T08:00:00Z") },
          { uid: 9, internalDate: "2026-11-04T09:00:00Z" },
        ],
        downloaded: [],
      });

      await adapter(context()).signalsSince!(SINCE);

      expect(imap.locks).toEqual([{ path: "INBOX", readOnly: true }]);
      expect(imap.searches).toEqual([new Date("2026-11-03T08:00:00Z")]);
      expect(imap.fetchedUids).toEqual([[8, 9]]);
      expect(imap.sourceLimits).toEqual([256 * 1024]);
    });

    it("sorts out each message, oldest first, by its Message-ID or else its UID, without the mailbox's own", async () => {
      const { adapter } = fakeServers({
        dated: [
          { uid: 8, internalDate: new Date("2026-11-04T08:30:00Z") },
          { uid: 9, internalDate: new Date("2026-11-04T08:40:00Z") },
          { uid: 10, internalDate: new Date("2026-11-04T08:50:00Z") },
          { uid: 11, internalDate: new Date("2026-11-04T08:20:00Z") },
          { uid: 12, internalDate: new Date("2026-11-04T08:25:00Z") },
        ],
        downloaded: [
          { uid: 8, internalDate: new Date("2026-11-04T08:30:00Z"), source: Buffer.from(REPLY) },
          { uid: 9, internalDate: new Date("2026-11-04T08:40:00Z"), source: Buffer.from(OWN_MAIL) },
          { uid: 10, internalDate: new Date("2026-11-04T08:50:00Z") },
          { uid: 11, internalDate: new Date("2026-11-04T08:20:00Z"), source: Buffer.from(GMAIL_DSN) },
          { uid: 12, internalDate: new Date("2026-11-04T08:25:00Z"), source: Buffer.from(NO_ID) },
        ],
      });

      const signals = await adapter(context()).signalsSince!(SINCE);

      expect(signals.map(({ type, externalId, address }) => [type, externalId, address])).toEqual([
        ["bounced", "<66f2.1c0a.dsn@mx.google.com>", "jeanne@acme.fr"],
        ["replied", "uid:12", "paul@acme.fr"],
        ["replied", "<reply-1@acme.fr>", "jeanne@acme.fr"],
      ]);
      expect(signals[2]).toMatchObject({ at: new Date("2026-11-04T08:30:00Z"), inReplyTo: "<first-step@northwind.fr>", detail: "Re: Votre holding\nOui, parlons-en jeudi." });
    });

    it("downloads nothing when the search finds nothing, and closes everything it opened", async () => {
      const { adapter, imap } = fakeServers({ session: { search: async () => false } });

      expect(await adapter(context()).signalsSince!(SINCE)).toEqual([]);
      expect(imap.fetchedUids).toEqual([]);
      expect(imap.released).toBe(1);
      expect(imap.loggedOut).toBe(1);
    });

    it("downloads nothing when nothing found is recent enough", async () => {
      const { adapter, imap } = fakeServers({ dated: [{ uid: 7, internalDate: new Date("2026-11-03T22:00:00Z") }] });

      expect(await adapter(context()).signalsSince!(SINCE)).toEqual([]);
      expect(imap.fetchedUids).toEqual([]);
    });

    it("closes the session when reading fails, and passes on the failure", async () => {
      const { adapter, imap } = fakeServers({ session: { search: () => Promise.reject(new Error("BAD search")) } });

      await expect(adapter(context()).signalsSince!(SINCE)).rejects.toThrow("BAD search");
      expect(imap.released).toBe(1);
      expect(imap.loggedOut).toBe(1);
    });

    it("isn't troubled by a logout that fails once the work is done", async () => {
      const { adapter } = fakeServers({ session: { logout: () => Promise.reject(new Error("connection closed")) } });

      await expect(adapter(context()).signalsSince!(SINCE)).resolves.toEqual([]);
    });
  });
});
