import { describe, expect, it } from "vitest";
import { headersOf, oldestFirst, signalOf } from "@/infrastructure/connectors/email/classify";
import { readMessage } from "@/infrastructure/connectors/email/mime";
import { GMAIL_DSN, inboxMessage, OUTLOOK_AUTO_REPLY_HEADERS } from "../support/email";

const MAILBOX = "marie@northwind.fr";
const REPORT = "multipart/report; report-type=delivery-status; boundary=b";

describe("a person's reply", () => {
  it("names the sender in lowercase, the message it answers, and its subject and first lines", () => {
    const signal = signalOf(
      inboxMessage({
        id: "gmail-18f",
        from: "Jeanne@ACME.fr",
        headers: { "in-reply-to": "<first-step@northwind.fr>" },
        text: "Bonjour Marie,\r\n\r\nOui, parlons-en jeudi.\r\n\r\nLe mar. 3 nov. 2026 à 10:00, Marie <marie@northwind.fr> a écrit :\r\n> Bonjour Jeanne,",
      }),
      MAILBOX,
    );

    expect(signal).toEqual({
      type: "replied",
      channel: "email",
      externalId: "gmail-18f",
      address: "jeanne@acme.fr",
      at: new Date("2026-11-04T10:00:00Z"),
      detail: "Re: Votre holding, une question\nBonjour Marie, Oui, parlons-en jeudi.",
      inReplyTo: "<first-step@northwind.fr>",
    });
  });

  it("finds what it answers in References when there is no In-Reply-To", () => {
    const signal = signalOf(inboxMessage({ headers: { references: "<zero@northwind.fr> <first-step@northwind.fr>" } }), MAILBOX);

    expect(signal?.inReplyTo).toBe("<first-step@northwind.fr>");
  });

  it.each([
    ["Outlook's separator", "Merci, non.\n________________________________\nDe : Marie\nObjet : Votre holding"],
    ["Outlook's header block", "Merci, non.\nDe\u00a0: Marie Durand\nEnvoyé : mardi"],
    ["a line naming the original", "Merci, non.\n-----Original Message-----\nHello"],
    ["Gmail's English attribution", "Merci, non.\nOn Tue, Nov 3, 2026 at 10:00 AM Marie wrote:\n> Hello"],
    ["a signature", "Merci, non.\n--\nJeanne Dupont"],
  ])("stops its first lines at %s", (_marker, text) => {
    expect(signalOf(inboxMessage({ subject: "", text }), MAILBOX)?.detail).toBe("Merci, non.");
  });

  it("keeps its detail to 280 characters, without splitting one", () => {
    const signal = signalOf(inboxMessage({ subject: "", text: "😀".repeat(400) }), MAILBOX);

    expect(Array.from(signal?.detail ?? "")).toHaveLength(280);
    expect(signal?.detail?.endsWith("😀…")).toBe(true);
  });

  it("isn't a notice for saying the word Action, or an auto-reply for an explicit Auto-Submitted: no", () => {
    const signal = signalOf(inboxMessage({ headers: { "auto-submitted": "no" }, text: "Action: rappeler lundi" }), MAILBOX);

    expect(signal?.type).toBe("replied");
  });

  it("isn't an auto-reply for answering about an absence", () => {
    expect(signalOf(inboxMessage({ subject: "Re: Absence de réponse" }), MAILBOX)?.type).toBe("replied");
  });
});

describe("an auto-reply", () => {
  it("is recognized in a French Outlook out-of-office, which names the sender", () => {
    const signal = signalOf(inboxMessage({ from: "Jeanne@acme.fr", subject: "Réponse automatique\u00a0: Votre holding", headers: headersOf(OUTLOOK_AUTO_REPLY_HEADERS), text: "Je suis absente jusqu'au 12 novembre." }), MAILBOX);

    expect(signal).toMatchObject({ type: "auto_reply", address: "jeanne@acme.fr", inReplyTo: "<first-step@northwind.fr>" });
  });

  it.each([
    ["Auto-Submitted: auto-replied", { "auto-submitted": "auto-replied; owner-email=jeanne@acme.fr" }],
    ["X-Autoreply", { "x-autoreply": "yes" }],
    ["X-Autorespond", { "x-autorespond": "1" }],
    ["Precedence: auto_reply", { precedence: "auto_reply" }],
    ["Precedence: bulk", { precedence: "Bulk" }],
  ])("is recognized by %s", (_name, headers) => {
    expect(signalOf(inboxMessage({ headers }), MAILBOX)?.type).toBe("auto_reply");
  });

  it.each(["Out of office: Votre holding", "Absence du bureau", "Absent jusqu'au 12", "Réponse automatique : Votre holding", "Automatic reply: Votre holding", "Message automatique"])("is recognized by the subject %s", (subject) => {
    expect(signalOf(inboxMessage({ subject }), MAILBOX)?.type).toBe("auto_reply");
  });
});

describe("a bounce", () => {
  it("names the failed recipient, not the daemon, from a Gmail report", async () => {
    const message = await readMessage(GMAIL_DSN, { id: "uid:7", receivedAt: new Date("2026-11-04T09:03:20Z") });

    expect(signalOf(message, MAILBOX)).toEqual({
      type: "bounced",
      channel: "email",
      externalId: "<66f2.1c0a.dsn@mx.google.com>",
      address: "jeanne@acme.fr",
      at: new Date("2026-11-04T09:03:20Z"),
      detail: "Delivery Status Notification (Failure)\n** Address not found ** Your message wasn't delivered to jeanne@acme.fr because the address couldn't be found.",
      inReplyTo: "<first-step@northwind.fr>",
    });
  });

  it("is still read when the message is cut at the download limit", async () => {
    const cut = GMAIL_DSN.slice(0, GMAIL_DSN.indexOf("Status: 5.1.1"));

    const signal = signalOf(await readMessage(cut, { id: "uid:7", receivedAt: new Date() }), MAILBOX);

    expect(signal).toMatchObject({ type: "bounced", address: "jeanne@acme.fr" });
  });

  it("finds the recipient in the report's Final-Recipient, then its Original-Recipient", () => {
    const report = { from: "postmaster@acme.fr", headers: { "content-type": REPORT } };

    expect(signalOf(inboxMessage({ ...report, text: "Final-Recipient: rfc822; <Jeanne@acme.fr>\nAction: failed" }), MAILBOX)?.address).toBe("jeanne@acme.fr");
    expect(signalOf(inboxMessage({ ...report, text: "Original-Recipient: rfc822;paul@acme.fr\nAction: failed" }), MAILBOX)?.address).toBe("paul@acme.fr");
  });

  it("says it doesn't know who failed rather than naming the daemon", () => {
    const signal = signalOf(inboxMessage({ from: "MAILER-DAEMON@mail.acme.fr", subject: "Undelivered Mail Returned to Sender" }), MAILBOX);

    expect(signal).toMatchObject({ type: "bounced", address: null });
  });

  it("wins over an auto-reply's headers, which reports carry too", () => {
    const signal = signalOf(inboxMessage({ from: "mailer-daemon@googlemail.com", headers: { "auto-submitted": "auto-replied", "x-failed-recipients": "jeanne@acme.fr" } }), MAILBOX);

    expect(signal).toMatchObject({ type: "bounced", address: "jeanne@acme.fr" });
  });
});

describe("what means nothing for prospecting", () => {
  it("is the mailbox's own mail, in any case", () => {
    expect(signalOf(inboxMessage({ from: "Marie@Northwind.fr" }), MAILBOX)).toBeNull();
  });

  it("is a read receipt, though it is a report", () => {
    expect(signalOf(inboxMessage({ headers: { "content-type": "multipart/report; report-type=disposition-notification" } }), MAILBOX)).toBeNull();
  });

  it("is a delivery delay, since the mail may still arrive", () => {
    const delay = { from: "mailer-daemon@googlemail.com", headers: { "content-type": REPORT, "x-failed-recipients": "jeanne@acme.fr" } };

    expect(signalOf(inboxMessage({ ...delay, text: "Final-Recipient: rfc822; jeanne@acme.fr\nAction: delayed" }), MAILBOX)).toBeNull();
    expect(signalOf(inboxMessage({ ...delay, subject: "Delivery Status Notification (Delay)" }), MAILBOX)).toBeNull();
  });

  it("isn't a bounce whose original was about a delay", () => {
    const signal = signalOf(inboxMessage({ from: "mailer-daemon@googlemail.com", subject: "Undeliverable: Delivery delayed? Une question", headers: { "x-failed-recipients": "jeanne@acme.fr" } }), MAILBOX);

    expect(signal?.type).toBe("bounced");
  });
});

describe("the signals of a read", () => {
  it("come oldest first, without what meant nothing", () => {
    const later = signalOf(inboxMessage({ id: "later", receivedAt: new Date("2026-11-04T11:00:00Z") }), MAILBOX);
    const earlier = signalOf(inboxMessage({ id: "earlier", receivedAt: new Date("2026-11-04T10:00:00Z") }), MAILBOX);

    expect(oldestFirst([later, null, earlier]).map((signal) => signal.externalId)).toEqual(["earlier", "later"]);
  });
});

describe("a message's headers", () => {
  it("are read by lowercased name, unfolded, the first of a repeated one kept", () => {
    const headers = headersOf([
      { name: "Content-Type", value: 'multipart/report;\r\n boundary="b"' },
      { name: "Received", value: "from a" },
      { name: "Received", value: "from b" },
    ]);

    expect(headers).toEqual({ "content-type": 'multipart/report; boundary="b"', received: "from a" });
  });
});
