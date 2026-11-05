import type { AdapterContext } from "@/infrastructure/connectors/adapter";

export interface FakeRoute {
  /** "POST https://api.brevo.com/v3/transactionalSMS/sms", or a prefix of a URL with its method. */
  match: string;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/**
 * A `fetch` that answers from canned routes (the first whose method and URL prefix match) and
 * records every call, so a test can check what an adapter sent. An unmatched call fails loudly.
 */
export function fakeFetch(routes: FakeRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchFake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body ? String(init.body) : "";
    calls.push({ method, url, headers: new Headers(init.headers), body });
    const route = routes.find((candidate) => {
      const [routeMethod, routeUrl] = candidate.match.split(" ");
      return routeMethod === method && url.startsWith(routeUrl);
    });
    if (!route) throw new Error(`Unexpected ${method} ${url}`);
    const payload = route.text ?? (route.json === undefined ? "" : JSON.stringify(route.json));
    return new Response(payload, { status: route.status ?? 200, headers: { "content-type": route.text ? "text/plain" : "application/json", ...route.headers } });
  }) as typeof fetch;
  return { fetch: fetchFake, calls };
}

/** An adapter's context for a test: these fields, this fake fetch, a fixed clock. */
export function adapterContext(fields: Record<string, string>, fetchFake: typeof fetch, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    fields,
    accessToken: async () => "test-access-token",
    hookUrl: "https://coldlyne.test/api/hooks/00000000-0000-4000-8000-000000000000?token=hook-token",
    fetch: fetchFake,
    now: () => new Date("2026-11-04T09:00:00Z"),
    ...overrides,
  };
}
