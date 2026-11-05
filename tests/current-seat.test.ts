import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as openWorkspaceLink } from "@/app/workspace/[workspaceId]/route";
import { startWorkspace } from "@/application/workspaces";
import { switchWorkspaceAction } from "@/components/workspace-actions";
import { currentSeat, enterWorkspace, forgetWorkspace, workspacesInBrowser } from "@/infrastructure/auth/session";
import type { Database } from "@/infrastructure/db/client";
import { user } from "@/infrastructure/db/schema/auth";
import { member } from "@/infrastructure/db/schema/tenancy";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";

const browser = vi.hoisted(() => ({ session: true, jar: new Map<string, string>(), set: vi.fn(), userId: "" }));
const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(browser.session ? { cookie: "better-auth.session_token=abc" } : {}),
  cookies: async () => ({
    get: (name: string) => (browser.jar.has(name) ? { name, value: browser.jar.get(name) } : undefined),
    set: (name: string, value: string, options: unknown) => {
      browser.jar.set(name, value);
      browser.set(name, value, options);
    },
    delete: (name: string) => browser.jar.delete(name),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/infrastructure/auth/server", () => ({ auth: () => ({ api: { getSession: async () => ({ user: { id: browser.userId, name: "Ada", email: "ada@acme.fr" } }) } }) }));
vi.mock("@/infrastructure/db/client", async (original) => ({ ...(await original<typeof import("@/infrastructure/db/client")>()), db: () => database.current }));
vi.mock("@/infrastructure/env", async (original) => ({ ...(await original<typeof import("@/infrastructure/env")>()), env: () => ({ BETTER_AUTH_URL: "https://coldlyne.test" }) }));

const COOKIE = "coldlyne_workspace";
const settings = { COLDLYNE_ADMINS: "founder@example.com" } as Env;

let db: Database;
beforeAll(async () => {
  db = await createTestDatabase();
  database.current = db;
});
beforeEach(() => {
  browser.session = true;
  browser.jar.clear();
  browser.set.mockClear();
});

/** A member with two workspaces of their own, and a stranger's beside them. */
async function twoWorkspaces() {
  const { workspaceId: first, userId } = await createTestWorkspace(db, "First");
  const second = (await startWorkspace(db, settings, { userId, email: "founder@example.com" }, "Second")) as string;
  const strangers = await createTestWorkspace(db, "Theirs");
  browser.userId = userId;
  return { first, second, userId, strangers: strangers.workspaceId };
}

const linkTo = (workspaceId: string, next = "/connections/gmail") => openWorkspaceLink(new Request(`https://coldlyne.test/workspace/${workspaceId}?next=${encodeURIComponent(next)}`), { params: Promise.resolve({ workspaceId }) });

describe("the seat on the screens", () => {
  it("is the member's first workspace when the browser asks for nothing, as for anyone with one", async () => {
    const { first, userId } = await twoWorkspaces();
    expect(await currentSeat()).toEqual({ userId, name: "Ada", email: "ada@acme.fr", workspaceId: first, workspaceName: "First", role: "owner" });
  });

  it("is the workspace the browser is in", async () => {
    const { second } = await twoWorkspaces();
    browser.jar.set(COOKIE, second);
    expect(await currentSeat()).toMatchObject({ workspaceId: second, workspaceName: "Second" });
  });

  it("falls back to their first when the cookie is forged to someone else's workspace, or to nothing", async () => {
    const { first, strangers } = await twoWorkspaces();
    for (const forged of [strangers, "not-a-uuid", "", "' or 1=1 --"]) {
      browser.jar.set(COOKIE, forged);
      expect(await currentSeat()).toMatchObject({ workspaceId: first, workspaceName: "First" });
    }
  });

  it("reads membership every time: a cookie outlives someone being taken out, and opens nothing", async () => {
    const { first, second, userId } = await twoWorkspaces();
    browser.jar.set(COOKIE, second);
    expect((await currentSeat()).workspaceId).toBe(second);
    await db.delete(member).where(and(eq(member.workspaceId, second), eq(member.userId, userId)));
    expect((await currentSeat()).workspaceId).toBe(first);
  });

  it("sends someone with no workspace to /welcome, and nobody to /sign-in", async () => {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Bea", email: `${id}@example.test` });
    browser.userId = id;
    await expect(currentSeat()).rejects.toThrow("NEXT_REDIRECT /welcome");
    browser.session = false;
    await expect(currentSeat()).rejects.toThrow("NEXT_REDIRECT /sign-in");
  });

  it("lists every workspace of theirs for the switcher, and no one else's", async () => {
    const { first, second } = await twoWorkspaces();
    browser.jar.set(COOKIE, second);
    const { workspaces, active } = await workspacesInBrowser(browser.userId);
    expect(workspaces.map(({ id }) => id)).toEqual([first, second]);
    expect(active?.id).toBe(second);
  });

  it("is remembered in a cookie scripts can't read, and forgotten on leaving", async () => {
    const { second } = await twoWorkspaces();
    await enterWorkspace(second);
    expect(browser.set).toHaveBeenCalledWith(COOKIE, second, expect.objectContaining({ httpOnly: true, sameSite: "lax", secure: true, path: "/" }));
    await forgetWorkspace();
    expect(browser.jar.has(COOKIE)).toBe(false);
  });
});

describe("switching workspace", () => {
  it("moves the browser to another of theirs, and home", async () => {
    const { second } = await twoWorkspaces();
    await expect(switchWorkspaceAction(second)).rejects.toThrow("NEXT_REDIRECT /");
    expect(browser.jar.get(COOKIE)).toBe(second);
    expect((await currentSeat()).workspaceId).toBe(second);
  });

  it("changes nothing when asked for someone else's", async () => {
    const { strangers } = await twoWorkspaces();
    await expect(switchWorkspaceAction(strangers)).rejects.toThrow("NEXT_REDIRECT /");
    expect(browser.jar.has(COOKIE)).toBe(false);
  });

  it("is only for someone signed in", async () => {
    const { second } = await twoWorkspaces();
    browser.session = false;
    await expect(switchWorkspaceAction(second)).rejects.toThrow("NEXT_REDIRECT /sign-in");
    expect(browser.jar.has(COOKIE)).toBe(false);
  });
});

describe("an assistant's link to a page", () => {
  it("enters the workspace the assistant was working in, then opens the page", async () => {
    const { second } = await twoWorkspaces();
    const response = await linkTo(second);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://coldlyne.test/connections/gmail");
    expect(browser.jar.get(COOKIE)).toBe(second);
  });

  it("opens the page without entering anything when the workspace isn't theirs", async () => {
    const { strangers } = await twoWorkspaces();
    const response = await linkTo(strangers);
    expect(response.headers.get("location")).toBe("https://coldlyne.test/connections/gmail");
    expect(browser.jar.has(COOKIE)).toBe(false);
  });

  it("goes nowhere outside the app", async () => {
    const { second } = await twoWorkspaces();
    expect((await linkTo(second, "https://evil.example")).headers.get("location")).toBe("https://coldlyne.test/");
    expect((await linkTo(second, "//evil.example")).headers.get("location")).toBe("https://coldlyne.test/");
  });

  it("asks to sign in first and comes back", async () => {
    const { second } = await twoWorkspaces();
    browser.session = false;
    const location = new URL((await linkTo(second)).headers.get("location") as string);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe(`/workspace/${second}?next=%2Fconnections%2Fgmail`);
    expect(browser.jar.has(COOKIE)).toBe(false);
  });
});
