import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/infrastructure/auth/server";

/** The same discovery for clients that look for OpenID's document. */
export const GET = (request: Request) => oauthProviderOpenIdConfigMetadata(auth())(request);
