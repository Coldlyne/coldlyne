"use client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/** Sign-in and the consent page's answer, from the browser. */
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
