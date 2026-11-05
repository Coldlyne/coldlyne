const callsATool = (message: unknown) => [message].flat().some((part) => (part as { method?: unknown } | null)?.method === "tools/call");

/**
 * A tool's answer, read to its end before the route returns. Today's clients get a stream with the
 * tool running behind it, and Next applies what a request changed in the cache when its route
 * returns: a sequence launched after that wouldn't wake the jobs. Nothing else is held back, since a
 * client's listening stream never ends.
 */
export async function answerInFull(request: Request, respond: (request: Request) => Promise<Response>): Promise<Response> {
  const message: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const response = await respond(request);
  if (!callsATool(message)) return response;
  return new Response(await response.text(), { status: response.status, headers: response.headers });
}
