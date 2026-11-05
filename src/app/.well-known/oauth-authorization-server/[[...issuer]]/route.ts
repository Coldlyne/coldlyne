import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/infrastructure/auth/server";

/** How an assistant finds Coldlyne's OAuth endpoints (RFC 8414), at the root and under the issuer's path. */
export const GET = (request: Request) => oauthProviderAuthServerMetadata(auth())(request);
