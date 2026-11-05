import type {
  CompanySource,
  ConnectorClient,
  ContactPusher,
  Dialer,
  DnsManager,
  EmailSender,
  LetterPoster,
  MeetingReader,
  Notifier,
  ReplyReader,
  ReputationReader,
  SheetReader,
  SmsSender,
  WhatsAppSender,
} from "@/application/ports";

/**
 * What an adapter is given to talk to its service: the connection's fields (secret or not, as the
 * member typed them), an OAuth access token for connections made by signing in (refreshed when
 * it expires), the address the service posts its webhooks to, and `fetch` and the clock, both
 * replaceable in tests.
 */
export interface AdapterContext {
  fields: Readonly<Record<string, string>>;
  accessToken: () => Promise<string>;
  hookUrl: string;
  fetch: typeof fetch;
  now: () => Date;
}

/** An adapter's client: the check every connection has, and the ports of its connector's capabilities. */
export type AdapterClient = ConnectorClient &
  Partial<EmailSender & ReplyReader & SmsSender & LetterPoster & Dialer & WhatsAppSender & MeetingReader & SheetReader & CompanySource & ContactPusher & Notifier & ReputationReader & DnsManager>;

export type Adapter = (context: AdapterContext) => AdapterClient;
