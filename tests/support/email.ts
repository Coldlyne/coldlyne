import type { OutgoingEmail } from "@/application/ports";
import type { InboxMessage } from "@/infrastructure/connectors/email/classify";

/** A first cold email, with the unsubscribe headers every step carries. */
export const COLD_EMAIL: OutgoingEmail = {
  to: "jeanne@acme.fr",
  subject: "Votre holding, une question",
  text: "Bonjour Jeanne,\n\nUne question sur votre holding.",
  html: "<p>Bonjour Jeanne,</p><p>Une question sur votre holding.</p>",
  headers: {
    "List-Unsubscribe": "<https://coldlyne.test/unsubscribe/abc123>, <mailto:stop@northwind.fr?subject=stop>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
};

/** The same prospect's second step, in the thread of the first. */
export const FOLLOW_UP: OutgoingEmail = {
  ...COLD_EMAIL,
  subject: "Re: Votre holding, une question",
  inReplyTo: "<first-step@northwind.fr>",
  references: ["<first-step@northwind.fr>"],
};

/** A message's header block, its folded lines put back on one. */
export function headerBlockOf(raw: Buffer | string): string {
  return raw.toString().split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
}

/** An inbox message for the classifier: a person writing, unless a test says otherwise. */
export function inboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "message-1",
    receivedAt: new Date("2026-11-04T10:00:00Z"),
    from: "jeanne@acme.fr",
    subject: "Re: Votre holding, une question",
    headers: {},
    text: "",
    ...overrides,
  };
}

/** The bounce Gmail sends its own users, as a raw message: a report in three parts, with the original. */
export const GMAIL_DSN = [
  "Delivered-To: marie@northwind.fr",
  "Received: by 2002:a05:6a00:1a4a with SMTP id h10; Wed, 4 Nov 2026 01:03:20 -0800 (PST)",
  "Return-Path: <>",
  "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  "To: marie@northwind.fr",
  "Auto-Submitted: auto-replied",
  "Subject: Delivery Status Notification (Failure)",
  "References: <first-step@northwind.fr>",
  "In-Reply-To: <first-step@northwind.fr>",
  "X-Failed-Recipients: Jeanne@acme.fr",
  "Message-ID: <66f2.1c0a.dsn@mx.google.com>",
  "Date: Wed, 04 Nov 2026 01:03:20 -0800 (PST)",
  'Content-Type: multipart/report; boundary="000000000000dsn"; report-type=delivery-status',
  "",
  "--000000000000dsn",
  'Content-Type: text/plain; charset="UTF-8"',
  "",
  "** Address not found **",
  "",
  "Your message wasn't delivered to jeanne@acme.fr because the address couldn't be found.",
  "--000000000000dsn",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns; googlemail.com",
  "Arrival-Date: Wed, 04 Nov 2026 01:03:19 -0800 (PST)",
  "",
  "Final-Recipient: rfc822; jeanne@acme.fr",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
  "--000000000000dsn",
  "Content-Type: message/rfc822",
  "",
  "From: Marie <marie@northwind.fr>",
  "To: jeanne@acme.fr",
  "Subject: Votre holding, une question",
  "",
  "Bonjour Jeanne,",
  "--000000000000dsn--",
  "",
].join("\r\n");

/** The headers Outlook puts on a French out-of-office message, as Graph lists them. */
export const OUTLOOK_AUTO_REPLY_HEADERS = [
  { name: "Received", value: "from PAXPR02MB7374.eurprd02.prod.outlook.com by AM9PR02MB6642.eurprd02.prod.outlook.com; Wed, 4 Nov 2026 09:12:41 +0000" },
  { name: "From", value: "Jeanne Dupont <Jeanne@acme.fr>" },
  { name: "To", value: "Marie <marie@northwind.fr>" },
  { name: "Subject", value: "=?utf-8?Q?R=C3=A9ponse_automatique=C2=A0:_Votre_holding?=" },
  { name: "In-Reply-To", value: "<first-step@northwind.fr>" },
  { name: "References", value: "<first-step@northwind.fr>" },
  { name: "Auto-Submitted", value: "auto-generated" },
  { name: "X-Auto-Response-Suppress", value: "All" },
  { name: "Content-Language", value: "fr-FR" },
  { name: "Content-Type", value: 'multipart/alternative; boundary="_000_PAXPR02MB7374_"' },
];

/** A failure report from Exchange, as `/messages/{id}/$value` gives it: no X-Failed-Recipients. */
export const EXCHANGE_NDR_MIME = [
  "From: Microsoft Outlook <postmaster@northwind.onmicrosoft.com>",
  "To: marie@northwind.fr",
  "Subject: =?utf-8?Q?Non_remis=C2=A0:_Votre_holding?=",
  "Message-ID: <ndr-1@AM9PR02MB6642.eurprd02.prod.outlook.com>",
  "In-Reply-To: <first-step@northwind.fr>",
  'Content-Type: multipart/report; report-type=delivery-status; boundary="ndr"',
  "",
  "--ndr",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Votre message n'a pas pu être remis.",
  "--ndr",
  "Content-Type: message/delivery-status",
  "",
  "Reporting-MTA: dns;AM9PR02MB6642.eurprd02.prod.outlook.com",
  "",
  "Final-Recipient: rfc822;jeanne@acme.fr",
  "Action: failed",
  "Status: 5.1.10",
  "--ndr--",
  "",
].join("\r\n");
