import { unsubscribe } from "@/application/unsubscribe";
import { appServices } from "@/infrastructure/services";

/** The one-click way out mailbox providers call (RFC 8058): no account and no page, the signed link is enough. */
export async function POST(_request: Request, { params }: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await params;
  return new Response(null, { status: (await unsubscribe(appServices(), token)) ? 200 : 404 });
}
