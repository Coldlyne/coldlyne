import { isAdmin, type Env } from "../env";

type SignInSettings = Pick<Env, "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET" | "OIDC_NAME" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "COLDLYNE_PASSWORD_SIGN_IN">;

/** A company's identity provider, as Better Auth knows it: members come back to /api/auth/callback/oidc. */
const COMPANY_PROVIDER = "oidc";

/** The company's identity provider (any OpenID Connect server), when all of it is set. */
export function companyLogin(settings: Pick<SignInSettings, "OIDC_ISSUER" | "OIDC_CLIENT_ID" | "OIDC_CLIENT_SECRET" | "OIDC_NAME">) {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = settings;
  if (!issuer || !clientId || !clientSecret) return null;
  // Basic is OpenID Connect's default for a client with a secret: a server may refuse any other method for it.
  return { providerId: COMPANY_PROVIDER, name: settings.OIDC_NAME, discoveryUrl: `${issuer}/.well-known/openid-configuration`, clientId, clientSecret, scopes: ["openid", "profile", "email"], authentication: "basic" as const };
}

export interface SignInMethods {
  provider: { id: string; name: string } | null;
  passwords: boolean;
}

/** The ways into this instance: its company's provider alone when it has one, otherwise Google and passwords as they are set up. */
export function signInOf(settings: SignInSettings): SignInMethods {
  if (companyLogin(settings)) return { provider: { id: COMPANY_PROVIDER, name: settings.OIDC_NAME }, passwords: false };
  const google = settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET;
  return { provider: google ? { id: "google", name: "Google" } : null, passwords: settings.COLDLYNE_PASSWORD_SIGN_IN };
}

/**
 * Whether a provider's account may be created while Coldlyne is private: for an address on the
 * list or with an invitation still good. Both trust the address, so the provider must have verified
 * it: an identity server may let anyone type any address.
 */
export const mayJoin = (person: { email: string; emailVerified?: boolean | null }, invited = false) => person.emailVerified === true && (invited || isAdmin(person.email));

/** Whether an account may be created with a password at this address. It isn't proved yet: the link mailed afterwards proves it, and sign-in stays closed until then. */
export const mayCreatePasswordAccount = (email: string, invited = false) => invited || isAdmin(email);

/** Why no account can be created with a password right now, if so: without mail nobody could ever get in. It's said to anyone, since it doesn't depend on the address. */
export function passwordSignUpClosed(settings: Pick<Env, "RESEND_API_KEY">): string | null {
  return settings.RESEND_API_KEY ? null : "Coldlyne ne peut pas encore envoyer le lien de confirmation : réessayez plus tard.";
}

const IGNORE_IT = "Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.";

/** The mails that prove an address is someone's: the link is the proof, so nothing else may be needed to use it. */
export const accountMail = {
  confirm: (url: string) => ({ subject: "Confirmez votre adresse pour Coldlyne", text: `Bonjour,\n\nPour activer votre compte Coldlyne, ouvrez ce lien :\n${url}\n\n${IGNORE_IT} Aucun compte ne sera activé.` }),
  reset: (url: string) => ({ subject: "Votre mot de passe Coldlyne", text: `Bonjour,\n\nPour choisir un nouveau mot de passe, ouvrez ce lien :\n${url}\n\n${IGNORE_IT} Votre mot de passe ne changera pas.` }),
};
