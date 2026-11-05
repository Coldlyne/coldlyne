import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentMember } from "@/infrastructure/auth/session";

const requestCookie = vi.hoisted(() => ({ value: "" }));
const getSession = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => vi.fn(() => ({ api: { getSession } })));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(requestCookie.value ? { cookie: requestCookie.value } : {}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/infrastructure/auth/server", () => ({ auth }));
vi.mock("@/infrastructure/db/client", () => ({ db: vi.fn() }));
vi.mock("@/application/workspaces", () => ({ workspacesOf: vi.fn() }));

beforeEach(() => {
  auth.mockClear();
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { id: "u1", name: "Ada", email: "ada@acme.fr" } });
});

describe("who is visiting", () => {
  it("is nobody without a session cookie, and auth doesn't even start, so nothing reads the database", async () => {
    requestCookie.value = "";
    expect(await currentMember()).toBeNull();
    requestCookie.value = "theme=dark";
    expect(await currentMember()).toBeNull();
    expect(auth).not.toHaveBeenCalled();
  });

  it.each(["better-auth.session_token=abc", "__Secure-better-auth.session_token=abc", "theme=dark; __Secure-better-auth.session_token=abc"])("is the member behind %s, in development and over https", async (cookie) => {
    requestCookie.value = cookie;
    expect(await currentMember()).toEqual({ userId: "u1", name: "Ada", email: "ada@acme.fr" });
  });

  it("is nobody when the cookie doesn't hold up", async () => {
    requestCookie.value = "__Secure-better-auth.session_token=expired";
    getSession.mockResolvedValue(null);
    expect(await currentMember()).toBeNull();
  });
});
