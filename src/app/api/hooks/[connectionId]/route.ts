import { receiveHook } from "@/application/signals";
import { env } from "@/infrastructure/env";
import { appServices } from "@/infrastructure/services";

/** Where a connected service posts what happened (an SMS reply, a call's outcome, a booking, a sign-up). */
async function handle(request: Request, { params }: RouteContext<"/api/hooks/[connectionId]">) {
  const { connectionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return new Response(null, { status: 404 });
  const given = new URL(request.url);
  // The address as the service was given it: signatures (Twilio's) cover it, and a proxy may have changed the host seen here.
  const url = new URL(given.pathname + given.search, env().BETTER_AUTH_URL).toString();
  const answer = await receiveHook(appServices(), connectionId, given.searchParams.get("token"), { method: request.method, url, headers: request.headers, body: await request.text() });
  return answer.response ?? new Response(answer.body ?? null, { status: answer.status });
}

export const GET = handle;
export const POST = handle;
