import { z } from "zod";

/**
 * What Coldlyne needs from its environment: its database, its sign-in, the key its connections'
 * credentials are sealed with, and its own OAuth apps. A workspace's credentials (mailboxes, SMS
 * providers, CRMs) live sealed in its rows, never here.
 */
const schema = z.object({
  COLDLYNE_DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  /** Who may sign up and start workspaces while Coldlyne is private: comma-separated emails. Anyone else needs an invitation, and can only join. */
  COLDLYNE_ADMINS: z.string().default(""),
  /** 32 random bytes, base64 (openssl rand -base64 32): seals every connection's credentials. */
  COLDLYNE_SECRETS_KEY: z.string().optional(),
  /** A company's own identity provider (any OpenID Connect server): when set, members sign in there and not with Google. */
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  /** Its name on the sign-in page. */
  OIDC_NAME: z.string().default("SSO"),
  /** Whether members may also sign in with an address and a password; a company's provider stays the only way in when set. */
  COLDLYNE_PASSWORD_SIGN_IN: z.stringbool().default(false),
  /** Google's OAuth app: sign-in unless a company's provider is set, and the Gmail, Calendar, Sheets and Postmaster connections. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Microsoft's (Entra ID) app: the Outlook mailbox and calendar connections. */
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** Coldlyne's own mail (sign-in links, alerts), through Resend; never prospecting. */
  RESEND_API_KEY: z.string().optional(),
  COLDLYNE_MAIL_FROM: z.string().default("Coldlyne <contact@coldlyne.com>"),
  /** Vercel cron calls the scheduled routes with this bearer. */
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let parsed: Env | undefined;

/** The environment, read once and checked. */
export function env(): Env {
  parsed ??= schema.parse(process.env);
  return parsed;
}

/** Whether this email may sign up without an invitation and start workspaces while Coldlyne is private. */
export function isAdmin(email: string, settings: Pick<Env, "COLDLYNE_ADMINS"> = env()): boolean {
  return settings.COLDLYNE_ADMINS.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes(email.trim().toLowerCase());
}
