import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConsentPage from "@/app/consent/page";

const asked = vi.hoisted(() => ({ client: null as { client_name?: string; client_uri?: string } | null, workspaces: [{ id: "w", name: "Northwind", role: "member" }] }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/infrastructure/auth/server", () => ({ auth: () => ({ api: { getOAuthClientPublic: async () => asked.client } }) }));
vi.mock("@/infrastructure/auth/session", () => ({ currentMember: async () => ({ userId: "ada", email: "ada@example.test" }), workspacesInBrowser: async () => ({ workspaces: [], active: null }) }));
vi.mock("@/infrastructure/auth/client", () => ({ authClient: {} }));
vi.mock("@/application/workspaces", () => ({ workspacesOf: async () => asked.workspaces, mayStartWorkspace: () => false }));
vi.mock("@/infrastructure/db/client", () => ({ db: () => ({}) }));
vi.mock("@/infrastructure/env", () => ({ env: () => ({}) }));

/** What the member reads: the page's one part that waits, waited for as a server would. */
async function screen(query: Record<string, string | string[] | undefined>) {
  const page = ConsentPage({ searchParams: Promise.resolve(query) } as PageProps<"/consent">);
  const request = page.props.children.props.children;
  return renderToStaticMarkup(await request.type(request.props));
}

const SPOOFED = { client_name: "Claude", client_uri: "https://claude.ai" };

beforeEach(() => {
  asked.client = SPOOFED;
});

describe("l’écran de consentement", () => {
  it("says where the access goes, and doesn't vouch for the address a client gave itself", async () => {
    const html = await screen({ client_id: "c", redirect_uri: "https://collector.attacker.example/callback?x=1" });
    expect(html).toContain("Claude demande à accéder");
    expect(html).toContain("collector.attacker.example");
    expect(html).not.toContain("claude.ai");
  });

  it("says the name is the client's own word", async () => {
    expect(await screen({ client_id: "c", redirect_uri: "https://collector.attacker.example/callback" })).toContain("choisi ce nom lui-même");
  });

  it("reads an address as a browser does: what comes before an @ isn't the host", async () => {
    const html = await screen({ client_id: "c", redirect_uri: "https://claude.ai@collector.attacker.example/callback" });
    expect(html).toContain("collector.attacker.example");
    expect(html).not.toContain("claude.ai");
  });

  it("names what a local or an app's address is too", async () => {
    expect(await screen({ client_id: "c", redirect_uri: "http://localhost:53682/callback" })).toContain("localhost:53682");
    expect(await screen({ client_id: "c", redirect_uri: "cursor://anysphere.cursor-mcp/oauth" })).toContain("cursor://anysphere.cursor-mcp");
  });

  it("says so when it can't tell where the access goes", async () => {
    for (const query of [{ client_id: "c" }, { client_id: "c", redirect_uri: "not an address" }, { client_id: "c", redirect_uri: ["https://a.example/", "https://b.example/"] }]) {
      const html = await screen(query);
      expect(html).toContain("Impossible de savoir");
      expect(html).not.toContain("a.example");
    }
  });

  it("mentions API keys among what it can do", async () => {
    expect(await screen({ client_id: "c", redirect_uri: "https://collector.attacker.example/callback" })).toContain("clés d’API");
  });
});
