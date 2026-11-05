import { NextResponse } from "next/server";
import { finishOAuthConnection } from "@/application/connection-grants";
import { currentMember } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

/** Where Google or Microsoft sends a member back after they granted (or refused) access. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (kindOrPage: string, params: Record<string, string> = {}) => NextResponse.redirect(new URL(`/connections/${kindOrPage}?${new URLSearchParams(params)}`, request.url));
  const member = await currentMember();
  if (!member) return NextResponse.redirect(new URL("/sign-in", request.url));
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return back("", { error: url.searchParams.get("error_description") ?? "L’accès n’a pas été accordé." });
  try {
    const result = await finishOAuthConnection(appServices(), member.userId, state, code);
    return result.ok ? back(result.connection.kind, { connected: result.connection.label }) : back("", { error: result.error });
  } catch (error) {
    return back("", { error: error instanceof Error ? error.message : "La connexion a échoué." });
  }
}
