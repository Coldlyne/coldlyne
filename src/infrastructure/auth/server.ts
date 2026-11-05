import "server-only";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { requestToResourceInput, verifyAccessTokenRequest } from "better-auth/oauth2";
import { genericOAuth, jwt } from "better-auth/plugins";
import { hasLiveInvitation } from "@/application/invitations";
import { SIGN_UP_REFUSED } from "@/domain/sign-up";
import { db, schema, type Database } from "../db/client";
import { env, type Env } from "../env";
import { sendOwnMail } from "../mail/own-mail";
import { accountMail, companyLogin, mayJoin, passwordSignUpRefusal, signInOf } from "./sign-in";

/** The MCP server's address: the only audience the assistants' tokens are good for. */
export const mcpResource = (settings: Pick<Env, "BETTER_AUTH_URL">) => new URL("/api/mcp", settings.BETTER_AUTH_URL).toString();

const PASSWORD_SIGN_UP = "/sign-up/email";

/**
 * Members sign in with the company's identity provider when the instance has one, otherwise with
 * Google or a password as the instance allows; while Coldlyne is private, only the instance's admins
 * and people with an invitation still good may create an account. Coldlyne is also an OAuth server for assistants: Claude, ChatGPT or any MCP
 * client registers itself, a member signs in and consents, and the assistant gets a token for /api/mcp.
 */
export function createAuth(database: Database, settings: Env) {
  const company = companyLogin(settings);
  const ways = signInOf(settings);
  const mail = (to: string, content: { subject: string; text: string }) => sendOwnMail(settings, fetch, { to, ...content });
  return betterAuth({
    baseURL: settings.BETTER_AUTH_URL,
    secret: settings.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database, { provider: "pg", schema }),
    socialProviders: !company && settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET ? { google: { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET, prompt: "select_account" } } : {},
    emailAndPassword: {
      enabled: ways.passwords,
      requireEmailVerification: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => void (await mail(user.email, accountMail.reset(url))),
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => void (await mail(user.email, accountMail.confirm(url))),
    },
    rateLimit: { storage: "database" },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const invited = await hasLiveInvitation(database, user.email, new Date());
            if (context?.path === PASSWORD_SIGN_UP) {
              const refusal = passwordSignUpRefusal(user.email, settings, invited);
              // Not a 403: Better Auth answers one here with a pretend success, and they'd wait for a mail that never comes.
              if (refusal) throw new APIError("UNPROCESSABLE_ENTITY", { message: refusal, code: SIGN_UP_REFUSED });
              return;
            }
            // False rather than an error: the provider's callback then sends the person back to the sign-in page.
            if (!mayJoin(user, invited)) return false;
          },
        },
      },
    },
    // The OAuth provider serves its own token endpoint; Better Auth's generic one stays off.
    disabledPaths: ["/token"],
    plugins: [
      jwt(),
      // Registered as a social provider: an assistant's pending request survives the round trip only through that route.
      genericOAuth({ config: company ? [company] : [] }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        resources: [mcpResource(settings)],
        clientRegistrationDefaultResources: [mcpResource(settings)],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Who signs tokens: Better Auth, under its base path. */
export const tokenIssuer = (settings: Pick<Env, "BETTER_AUTH_URL">) => new URL("/api/auth", settings.BETTER_AUTH_URL).toString();

/** Whose token a request to /api/mcp carries: its signature, issuer, audience and expiry checked. Throws when any fails. */
export async function memberOfToken(request: Request, settings: Pick<Env, "BETTER_AUTH_URL">): Promise<{ userId: string; clientId: string }> {
  const issuer = tokenIssuer(settings);
  const payload = await verifyAccessTokenRequest(requestToResourceInput(request), { jwksUrl: `${issuer}/jwks`, verifyOptions: { issuer, audience: mcpResource(settings) } });
  if (typeof payload.sub !== "string") throw new Error("This token isn't a member's.");
  return { userId: payload.sub, clientId: typeof payload.azp === "string" ? payload.azp : "" };
}

const globalForAuth = globalThis as unknown as { coldlyneAuth?: Auth };

/** The instance's auth, made on first use so a build without its environment still succeeds. */
export function auth(): Auth {
  globalForAuth.coldlyneAuth ??= createAuth(db(), env());
  return globalForAuth.coldlyneAuth;
}
