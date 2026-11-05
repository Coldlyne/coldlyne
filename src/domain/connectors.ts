/**
 * Every service a workspace can connect to Coldlyne, what each lets the assistant do, and how it
 * is authorized. Pure data: the screens list it, the MCP server describes it, and each kind has
 * one adapter in `infrastructure/connectors` that does the talking.
 *
 * Secrets (keys, tokens, passwords) are always typed into Coldlyne’s own connection page, never
 * into a conversation: an assistant’s chat history is not a place for them.
 */

export type ConnectorCategory = "source" | "email" | "sms" | "letter" | "telephony" | "whatsapp" | "calendar" | "crm" | "automation" | "deliverability";

/** What a connection lets Coldlyne do; an adapter implements the matching port. */
export type Capability =
  | "find_companies"
  | "read_sheet"
  | "send_email"
  | "read_replies"
  | "send_sms"
  | "post_letter"
  | "place_call"
  | "call_events"
  | "send_whatsapp"
  | "meetings"
  | "push_contacts"
  | "notify"
  | "reputation"
  | "dns_records"
  | "signups";

export interface Field {
  key: string;
  label: string;
  /** Sealed with the rest of the credentials, never shown again once saved. */
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export type OAuthProvider = "google" | "microsoft";

export type Authorization =
  /** The member signs in to the provider and grants these scopes. */
  | { kind: "oauth"; provider: OAuthProvider; scopes: readonly string[] }
  /** The member pastes what the provider’s console gives them. */
  | { kind: "fields"; fields: readonly Field[] }
  /** Nothing to type: Coldlyne makes a signed address the service posts to. */
  | { kind: "inbound" };

export interface Connector {
  kind: ConnectorKind;
  name: string;
  category: ConnectorCategory;
  /** One line, for the catalogue and the assistant. */
  summary: string;
  capabilities: readonly Capability[];
  authorization: Authorization;
  /** Where its data is processed, for the workspace’s GDPR register. */
  hosting: "EU" | "US" | "EU or US";
  /** The provider’s page that explains where to find what the fields ask for. */
  docs?: string;
  /**
   * What the service posts back to Coldlyne once connected (replies, STOPs, a call’s outcome, a
   * booking): the connection page then shows the signed address to paste in its console.
   */
  webhooks?: string;
}

const secret = (key: string, label: string, help?: string): Field => ({ key, label, secret: true, help });
const plain = (key: string, label: string, extra: Partial<Field> = {}): Field => ({ key, label, secret: false, ...extra });

const GOOGLE_PROFILE = ["openid", "email"] as const;
const MICROSOFT_PROFILE = ["openid", "email", "offline_access", "User.Read"] as const;
const SENDER = plain("sender", "Expéditeur affiché", { placeholder: "ACME", help: "11 caractères au plus, lettres et chiffres." });

export const CONNECTORS = [
  // ─── Where prospects come from ─────────────────────────────────────────────
  {
    kind: "sirene",
    name: "INSEE Sirene",
    category: "source",
    summary: "Établissements, effectifs et activité de chaque entreprise, depuis l’API Sirene de l’INSEE.",
    capabilities: ["find_companies"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API (portail des API de l’INSEE)")] },
    hosting: "EU",
    docs: "https://portail-api.insee.fr/",
  },
  {
    kind: "inpi",
    name: "INPI, registre national des entreprises",
    category: "source",
    summary: "Dirigeants et actes déposés, depuis l’API du RNE, pour vous renseigner sur une entreprise.",
    capabilities: ["find_companies"],
    authorization: { kind: "fields", fields: [plain("username", "Adresse email du compte INPI"), secret("password", "Mot de passe INPI")] },
    hosting: "EU",
    docs: "https://data.inpi.fr/content/editorial/Acces_API_Entreprises",
  },
  {
    kind: "google_sheets",
    name: "Google Sheets",
    category: "source",
    summary: "Importer des prospects depuis une feuille de calcul.",
    capabilities: ["read_sheet"],
    authorization: { kind: "oauth", provider: "google", scopes: [...GOOGLE_PROFILE, "https://www.googleapis.com/auth/spreadsheets.readonly"] },
    hosting: "EU or US",
    docs: "https://developers.google.com/sheets/api",
  },

  // ─── Email, from the workspace’s own mailboxes ─────────────────────────────
  {
    kind: "gmail",
    name: "Google Workspace",
    category: "email",
    summary: "Envoyer depuis une boîte Gmail et lire ses réponses.",
    capabilities: ["send_email", "read_replies"],
    authorization: { kind: "oauth", provider: "google", scopes: [...GOOGLE_PROFILE, "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"] },
    hosting: "EU or US",
    docs: "https://developers.google.com/gmail/api",
  },
  {
    kind: "microsoft365",
    name: "Microsoft 365",
    category: "email",
    summary: "Envoyer depuis une boîte Outlook et lire ses réponses.",
    capabilities: ["send_email", "read_replies"],
    authorization: { kind: "oauth", provider: "microsoft", scopes: [...MICROSOFT_PROFILE, "Mail.Send", "Mail.Read"] },
    hosting: "EU or US",
    docs: "https://learn.microsoft.com/graph/outlook-mail-concept-overview",
  },
  {
    kind: "smtp",
    name: "SMTP et IMAP",
    category: "email",
    summary: "N’importe quelle boîte : OVHcloud, Infomaniak, Gandi, Ionos…",
    capabilities: ["send_email", "read_replies"],
    authorization: {
      kind: "fields",
      fields: [
        plain("address", "Adresse", { placeholder: "ada@acme.fr" }),
        plain("displayName", "Nom affiché", { optional: true, placeholder: "Ada, de chez Acme" }),
        plain("smtpHost", "Serveur SMTP", { placeholder: "ssl0.ovh.net" }),
        plain("smtpPort", "Port SMTP", { placeholder: "465" }),
        plain("imapHost", "Serveur IMAP", { placeholder: "ssl0.ovh.net" }),
        plain("imapPort", "Port IMAP", { placeholder: "993" }),
        plain("username", "Identifiant", { optional: true, help: "L’adresse, le plus souvent." }),
        secret("password", "Mot de passe"),
      ],
    },
    hosting: "EU or US",
    docs: "https://help.ovhcloud.com/csm/fr-email-general-settings?id=kb_article_view&sysparm_article=KB0050965",
  },

  // ─── SMS ───────────────────────────────────────────────────────────────────
  {
    kind: "brevo_sms",
    name: "Brevo",
    category: "sms",
    summary: "SMS envoyés par Brevo, et les STOP en retour.",
    capabilities: ["send_sms"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API"), SENDER] },
    hosting: "EU",
    docs: "https://developers.brevo.com/docs/transactional-sms-endpoints",
    webhooks: "les STOP et les accusés de réception",
  },
  {
    kind: "ovh_sms",
    name: "OVHcloud SMS",
    category: "sms",
    summary: "SMS envoyés par OVHcloud, et les STOP en retour.",
    capabilities: ["send_sms", "read_replies"],
    authorization: {
      kind: "fields",
      fields: [plain("applicationKey", "Application key"), secret("applicationSecret", "Application secret"), secret("consumerKey", "Consumer key"), plain("serviceName", "Compte SMS", { placeholder: "sms-ab12345-1" }), SENDER],
    },
    hosting: "EU",
    docs: "https://help.ovhcloud.com/csm/fr-sms-sending-via-api-nodejs?id=kb_article_view&sysparm_article=KB0051395",
  },
  {
    kind: "smsmode",
    name: "smsmode",
    category: "sms",
    summary: "SMS envoyés par smsmode, et les STOP en retour.",
    capabilities: ["send_sms"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API"), SENDER] },
    hosting: "EU",
    docs: "https://dev.smsmode.com/sms/v1/message",
    webhooks: "les STOP et les accusés de réception",
  },

  // ─── Letters ───────────────────────────────────────────────────────────────
  {
    kind: "merci_facteur",
    name: "Merci Facteur",
    category: "letter",
    summary: "Lettres imprimées, mises sous pli et postées au siège.",
    capabilities: ["post_letter"],
    authorization: { kind: "fields", fields: [plain("serviceId", "Identifiant du service"), secret("secretKey", "Clé secrète"), plain("userId", "Identifiant de l’utilisateur", { placeholder: "4417", help: "Dans le menu Utilisateurs de Merci Facteur Pro. Les courriers partent en son nom." })] },
    hosting: "EU",
    docs: "https://www.merci-facteur.com/api/documentation",
  },
  {
    kind: "maileva",
    name: "Maileva (La Poste)",
    category: "letter",
    summary: "Lettres simples, postées par La Poste.",
    capabilities: ["post_letter"],
    authorization: {
      kind: "fields",
      fields: [plain("clientId", "Client ID"), secret("clientSecret", "Client secret"), plain("username", "Identifiant Maileva"), secret("password", "Mot de passe Maileva")],
    },
    hosting: "EU",
    docs: "https://www.maileva.com/catalogue-api/",
  },

  // ─── Calls ─────────────────────────────────────────────────────────────────
  {
    kind: "twilio",
    name: "Twilio Voice",
    category: "telephony",
    summary: "Appeler depuis Coldlyne, et laisser le message vocal en un clic.",
    capabilities: ["place_call", "call_events"],
    authorization: { kind: "fields", fields: [plain("accountSid", "Account SID"), secret("authToken", "Auth token"), plain("callerId", "Numéro appelant", { placeholder: "+33 1 23 45 67 89" })] },
    hosting: "EU or US",
    docs: "https://www.twilio.com/docs/voice/api",
    webhooks: "l’issue de chaque appel",
  },
  {
    kind: "aircall",
    name: "Aircall",
    category: "telephony",
    summary: "Lancer les appels dans Aircall et en relever l’issue.",
    capabilities: ["place_call", "call_events"],
    authorization: { kind: "fields", fields: [plain("apiId", "API ID"), secret("apiToken", "API token")] },
    hosting: "EU or US",
    docs: "https://developer.aircall.io/api-references/",
    webhooks: "l’issue de chaque appel",
  },
  {
    kind: "ringover",
    name: "Ringover",
    category: "telephony",
    summary: "Lancer les appels dans Ringover et en relever l’issue.",
    capabilities: ["place_call", "call_events"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API"), { ...secret("webhookSecret", "Secret des webhooks d’appels"), optional: true }] },
    hosting: "EU",
    docs: "https://developer.ringover.com/",
    webhooks: "l’issue de chaque appel",
  },

  // ─── WhatsApp ──────────────────────────────────────────────────────────────
  {
    kind: "whatsapp_cloud",
    name: "WhatsApp Business",
    category: "whatsapp",
    summary: "Messages modèles approuvés, aux personnes qui ont accepté, et leurs réponses.",
    capabilities: ["send_whatsapp"],
    authorization: {
      kind: "fields",
      fields: [plain("phoneNumberId", "Phone number ID"), plain("businessAccountId", "WhatsApp Business Account ID"), secret("accessToken", "Jeton d’accès (utilisateur système)"), secret("appSecret", "App secret", "Pour vérifier la signature des webhooks.")],
    },
    hosting: "EU or US",
    docs: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    webhooks: "les réponses et les statuts des messages",
  },

  // ─── Meetings ──────────────────────────────────────────────────────────────
  {
    kind: "google_calendar",
    name: "Google Agenda",
    category: "calendar",
    summary: "Un rendez-vous avec un prospect compte comme un résultat.",
    capabilities: ["meetings"],
    authorization: { kind: "oauth", provider: "google", scopes: [...GOOGLE_PROFILE, "https://www.googleapis.com/auth/calendar.events.readonly"] },
    hosting: "EU or US",
    docs: "https://developers.google.com/calendar/api",
  },
  {
    kind: "microsoft_calendar",
    name: "Agenda Outlook",
    category: "calendar",
    summary: "Un rendez-vous avec un prospect compte comme un résultat.",
    capabilities: ["meetings"],
    authorization: { kind: "oauth", provider: "microsoft", scopes: [...MICROSOFT_PROFILE, "Calendars.Read"] },
    hosting: "EU or US",
    docs: "https://learn.microsoft.com/graph/outlook-calendar-concept-overview",
  },
  {
    kind: "calcom",
    name: "Cal.com",
    category: "calendar",
    summary: "Les réservations sur vos liens Cal.com.",
    capabilities: ["meetings"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API")] },
    hosting: "EU or US",
    docs: "https://cal.com/docs/api-reference/v2/introduction",
    webhooks: "chaque réservation et chaque annulation",
  },
  {
    kind: "calendly",
    name: "Calendly",
    category: "calendar",
    summary: "Les réservations sur vos liens Calendly.",
    capabilities: ["meetings"],
    authorization: { kind: "fields", fields: [secret("token", "Jeton d’accès personnel")] },
    hosting: "US",
    docs: "https://developer.calendly.com/",
  },

  // ─── Where results go ──────────────────────────────────────────────────────
  {
    kind: "hubspot",
    name: "HubSpot",
    category: "crm",
    summary: "Chaque prospect qui répond, avec son entreprise et son historique.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [secret("accessToken", "Clé de service ou jeton d’application privée")] },
    hosting: "EU or US",
    docs: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys",
  },
  {
    kind: "pipedrive",
    name: "Pipedrive",
    category: "crm",
    summary: "Chaque prospect qui répond, en personne et organisation.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [plain("companyDomain", "Sous-domaine", { placeholder: "acme" }), secret("apiToken", "Jeton d’API")] },
    hosting: "EU or US",
    docs: "https://developers.pipedrive.com/docs/api/v1",
  },
  {
    kind: "sellsy",
    name: "Sellsy",
    category: "crm",
    summary: "Chaque prospect qui répond, en contact et société.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [plain("clientId", "Client ID (accès personnel)"), secret("clientSecret", "Client secret")] },
    hosting: "EU",
    docs: "https://api.sellsy.com/doc/v2/",
  },
  {
    kind: "axonaut",
    name: "Axonaut",
    category: "crm",
    summary: "Chaque prospect qui répond, en contact et société.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API")] },
    hosting: "EU",
    docs: "https://axonaut.com/api/v2/doc",
  },
  {
    kind: "nocrm",
    name: "noCRM.io",
    category: "crm",
    summary: "Chaque prospect qui répond, en piste.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [plain("subdomain", "Sous-domaine", { placeholder: "acme" }), secret("apiKey", "Clé d’API")] },
    hosting: "EU",
    docs: "https://youdontneedacrm.com/api",
  },
  {
    kind: "folk",
    name: "folk",
    category: "crm",
    summary: "Chaque prospect qui répond, en personne et entreprise.",
    capabilities: ["push_contacts"],
    authorization: { kind: "fields", fields: [secret("apiKey", "Clé d’API")] },
    hosting: "EU",
    docs: "https://developer.folk.app/",
  },
  {
    kind: "slack",
    name: "Slack",
    category: "automation",
    summary: "Un message dans un canal quand un prospect répond ou prend rendez-vous.",
    capabilities: ["notify"],
    authorization: { kind: "fields", fields: [secret("webhookUrl", "URL du webhook entrant")] },
    hosting: "US",
    docs: "https://api.slack.com/messaging/webhooks",
  },
  {
    kind: "webhook",
    name: "Webhook (n8n, Make, Zapier)",
    category: "automation",
    summary: "Chaque événement envoyé, signé, à l’adresse de votre choix.",
    capabilities: ["notify"],
    authorization: { kind: "fields", fields: [plain("url", "URL", { placeholder: "https://n8n.acme.fr/webhook/coldlyne" })] },
    hosting: "EU or US",
  },
  {
    kind: "signups",
    name: "Inscriptions de votre site",
    category: "automation",
    summary: "Votre site signale chaque inscription : elle est créditée au message qui l’a amenée.",
    capabilities: ["signups"],
    authorization: { kind: "inbound" },
    hosting: "EU",
    webhooks: "chaque inscription, avec l’adresse de la personne",
  },

  // ─── Deliverability ────────────────────────────────────────────────────────
  {
    kind: "postmaster",
    name: "Google Postmaster Tools",
    category: "deliverability",
    summary: "Le taux de spam de votre domaine d’envoi chez Gmail, jour par jour.",
    capabilities: ["reputation"],
    authorization: { kind: "oauth", provider: "google", scopes: [...GOOGLE_PROFILE, "https://www.googleapis.com/auth/postmaster.traffic.readonly", "https://www.googleapis.com/auth/postmaster.domain"] },
    hosting: "EU or US",
    docs: "https://developers.google.com/gmail/postmaster",
  },
  {
    kind: "vercel_dns",
    name: "Vercel DNS",
    category: "deliverability",
    summary: "Poser SPF, DKIM et DMARC sur un domaine d’envoi hébergé chez Vercel.",
    capabilities: ["dns_records"],
    authorization: { kind: "fields", fields: [secret("token", "Jeton d’accès"), plain("teamId", "Team ID", { optional: true })] },
    hosting: "US",
    docs: "https://vercel.com/docs/rest-api/reference/endpoints/dns",
  },
  {
    kind: "cloudflare_dns",
    name: "Cloudflare DNS",
    category: "deliverability",
    summary: "Poser SPF, DKIM et DMARC sur un domaine d’envoi hébergé chez Cloudflare.",
    capabilities: ["dns_records"],
    authorization: { kind: "fields", fields: [secret("apiToken", "Jeton d’API (Zone : lire, DNS : modifier)")] },
    hosting: "EU or US",
    docs: "https://developers.cloudflare.com/api/resources/dns/",
  },
  {
    kind: "ovh_dns",
    name: "OVHcloud DNS",
    category: "deliverability",
    summary: "Poser SPF, DKIM et DMARC sur un domaine d’envoi hébergé chez OVHcloud.",
    capabilities: ["dns_records"],
    authorization: { kind: "fields", fields: [plain("applicationKey", "Application key"), secret("applicationSecret", "Application secret"), secret("consumerKey", "Consumer key")] },
    hosting: "EU",
    docs: "https://help.ovhcloud.com/csm/fr-api-getting-started-ovhcloud-api?id=kb_article_view&sysparm_article=KB0042789",
  },
] as const satisfies readonly ConnectorSpec[];

/** A connector as written in the list above, before its kind is narrowed. */
type ConnectorSpec = Omit<Connector, "kind"> & { kind: string };

export type ConnectorKind = (typeof CONNECTORS)[number]["kind"];

const byKind = new Map<string, Connector>(CONNECTORS.map((connector) => [connector.kind, connector as Connector]));

export function connectorOf(kind: string): Connector | undefined {
  return byKind.get(kind);
}

export const isConnectorKind = (kind: string): kind is ConnectorKind => byKind.has(kind);

export const CATEGORY_NAMES: Record<ConnectorCategory, string> = {
  source: "Sources de prospects",
  email: "Email",
  sms: "SMS",
  letter: "Courrier",
  telephony: "Appels",
  whatsapp: "WhatsApp",
  calendar: "Rendez-vous",
  crm: "CRM",
  automation: "Alertes et automatisations",
  deliverability: "Délivrabilité",
};

/**
 * The fields a member must type for a connector, checked: every required one present and
 * trimmed, nothing unknown kept. Returns what is missing instead when something is.
 */
export function readFields(connector: Connector, values: Record<string, unknown>): { ok: true; values: Record<string, string> } | { ok: false; missing: string[] } {
  if (connector.authorization.kind !== "fields") return { ok: true, values: {} };
  const read: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of connector.authorization.fields) {
    const value = typeof values[field.key] === "string" ? (values[field.key] as string).trim() : "";
    if (value) read[field.key] = value;
    else if (!field.optional) missing.push(field.label);
  }
  return missing.length ? { ok: false, missing } : { ok: true, values: read };
}
