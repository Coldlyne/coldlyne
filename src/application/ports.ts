import type { Channel } from "@/domain/sequences";
import type { Capability } from "@/domain/connectors";
import type { OffLimitsEntry } from "@/domain/crm-exclusions";
import type { DnsRecord } from "@/domain/deliverability";

/**
 * What the use cases ask of a connected service, one port per capability. Each adapter in
 * `infrastructure/connectors` implements `ConnectorClient` and the ports of the capabilities its
 * connector lists; the use cases never know which provider is behind a port.
 */

export type { Channel } from "@/domain/sequences";

/** Whether the service accepts what was saved, and what to call the connection. */
export interface Check {
  ok: boolean;
  /** Why not, or what was found ("3 numéros", "boîte ada@acme.fr"), in the member's words. */
  detail: string;
  /** A name for the connection: the mailbox's address, the account's name. */
  label?: string;
}

export interface ConnectorClient {
  check(): Promise<Check>;
  /** For a connector that posts back to Coldlyne (its `webhooks`): reads what it posted. */
  readWebhook?: WebhookReader["readWebhook"];
}

// ─── What comes back: one shape for every channel ──────────────────────────

export type SignalType =
  | "replied"
  | "auto_reply"
  | "bounced"
  | "opted_out"
  | "delivered"
  | "failed"
  | "answered"
  | "no_answer"
  | "voicemail_left"
  | "meeting_booked"
  | "meeting_cancelled"
  | "signed_up";

/**
 * Something a prospect (or their mail server) did, as a service reported it: a reply, a bounce,
 * a STOP, a call's outcome, a booked meeting, a sign-up. Matched to prospects by address.
 */
export interface Signal {
  type: SignalType;
  channel: Channel | "calendar" | "site";
  /** The service's own id for it, so the same event is never recorded twice. */
  externalId: string;
  /** Who it is about: a lowercased email address or an E.164 phone number. */
  address: string | null;
  at: Date;
  /** A subject, the first lines of a reply, a call's duration… */
  detail?: string;
  /** For email: the message it answers, to find the step it came from. */
  inReplyTo?: string;
}

// ─── Ports ─────────────────────────────────────────────────────────────────

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** List-Unsubscribe and List-Unsubscribe-Post (RFC 8058), and anything else the step needs. */
  headers: Record<string, string>;
  /** Set on a follow-up, to stay in the prospect's thread. */
  inReplyTo?: string;
  references?: string[];
}

export interface SentMessage {
  /** The provider's id for it (Gmail's message id, the SMS id, the letter's tracking id…). */
  externalId: string;
  /** For email: the Message-ID header, which a reply's In-Reply-To names. */
  messageId?: string;
  threadId?: string;
}

export interface EmailSender {
  sendEmail(email: OutgoingEmail): Promise<SentMessage>;
}

export interface ReplyReader {
  /** Replies, bounces and opt-outs that arrived since then, oldest first. */
  signalsSince(since: Date): Promise<Signal[]>;
}

export interface SmsSender {
  /** `to` in E.164; the text ends with how to stop. The adapter replaces that mention with the provider's own, whose number only the provider knows. */
  sendSms(sms: { to: string; text: string }): Promise<SentMessage>;
}

export interface PostalAddress {
  name: string;
  /** The company, for a letter to its registered office. */
  company?: string;
  lines: string[];
  postcode: string;
  city: string;
  country: "FR";
}

export interface LetterPoster {
  postLetter(letter: { to: PostalAddress; from: PostalAddress; pdf: Uint8Array; reference: string }): Promise<SentMessage & { cost?: number }>;
}

export interface Dialer {
  /**
   * Rings the member first, then the prospect: the member is always on the line, so a voicemail
   * is only ever left during a call they placed (L34-5 CPCE). `voicemailUrl` is the recording a
   * click leaves when the call lands on voicemail, where the provider can play one.
   */
  placeCall(call: { memberPhone: string; prospectPhone: string; voicemailUrl?: string; reference: string }): Promise<SentMessage>;
  /**
   * The member's one click when a call lands on voicemail: the prospect's line hears the recording
   * and hangs up. Only ever during the call `callId` names (what `placeCall` returned), which the
   * member placed: never ringless. Absent where the provider can't play one.
   */
  dropVoicemail?(callId: string, recordingUrl: string): Promise<void>;
}

export interface WhatsAppSender {
  /** A message template Meta approved: the only way to open a conversation. */
  sendTemplate(message: { to: string; template: string; language: string; parameters: string[] }): Promise<SentMessage>;
}

export interface MeetingReader {
  /** Meetings booked or cancelled since then, with the guest's address. */
  meetingsSince(since: Date): Promise<Signal[]>;
}

export interface SheetReader {
  /** The rows of a sheet's first tab (or a range), keyed by its header row. */
  rows(spreadsheetId: string, range?: string): Promise<Record<string, string>[]>;
}

export interface CompanyFacts {
  siren: string;
  name: string;
  /** Head office and establishments, headcount band, directors and filings, as the source has them. */
  facts: Record<string, unknown>;
}

export interface CompanySource {
  /** What this source knows about a company, by its SIREN. */
  company(siren: string): Promise<CompanyFacts | null>;
}

export interface CrmContact {
  firstName: string | null;
  lastName: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  company: { name: string; siren: string | null; website: string | null };
  /** What happened, in a line: "A répondu à l'email 2 : intéressé". Empty when there's nothing to add. */
  note: string;
  /** Through which channel it happened, when something did. */
  channel?: Channel;
}

export interface ContactPusher {
  /** Creates or updates the person and their company, and adds the note. */
  pushContact(contact: CrmContact): Promise<{ externalId: string }>;
}

/** A CRM linked both ways: who it holds as customers and open deals, whom a workspace must not prospect. */
export interface LinkedCrm {
  offLimits(): Promise<OffLimitsEntry[]>;
}

export interface Notification {
  event: "replied" | "meeting_booked" | "signed_up" | "connection_failing" | "mailbox_paused" | "watchlist" | "test";
  title: string;
  text: string;
  /** Where to see it in Coldlyne. */
  url?: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export type { DnsRecord };

export interface DnsManager {
  records(domain: string): Promise<DnsRecord[]>;
  /** Adds the record, or replaces the one of the same type and name. */
  upsertRecord(domain: string, record: DnsRecord): Promise<void>;
}

export interface DomainReputation {
  date: string;
  /** Gmail's verdict: HIGH, MEDIUM, LOW, BAD. Postmaster Tools' v2 no longer gives one, so null today. */
  reputation: string | null;
  /** The share of mail users marked as spam that day, from 0 to 1. */
  spamRate: number | null;
}

export interface ReputationReader {
  reputation(domain: string, days: number): Promise<DomainReputation[]>;
}

/** What a service posts to Coldlyne (an SMS reply, a call's outcome, a booking), checked and read. */
export interface InboundRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export interface WebhookReader {
  /**
   * The signals in a request a service posted, after checking it really came from the service
   * (its signature). Throws on a forged or unreadable one. A provider's handshake (WhatsApp's
   * verification challenge) answers with `reply` instead.
   */
  readWebhook(request: InboundRequest): Promise<{ signals: Signal[]; reply?: Response }>;
}

/** The port each capability is served by. */
export interface Ports {
  find_companies: CompanySource;
  read_sheet: SheetReader;
  send_email: EmailSender;
  read_replies: ReplyReader;
  send_sms: SmsSender;
  post_letter: LetterPoster;
  place_call: Dialer;
  call_events: WebhookReader;
  send_whatsapp: WhatsAppSender;
  meetings: MeetingReader;
  push_contacts: ContactPusher;
  linked_crm: LinkedCrm;
  notify: Notifier;
  reputation: ReputationReader;
  dns_records: DnsManager;
  signups: WebhookReader;
}

export type CapabilityPort<C extends Capability> = Ports[C];
