import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeysOf, createApiKey, revokeApiKey, workspaceOfKey } from "@/application/api-keys";
import { connectWithFields, type ConnectionView } from "@/application/connections";
import { figuresOf } from "@/application/figures";
import type { Signal } from "@/application/ports";
import { addFromRegistry, createList } from "@/application/prospects";
import type { Services } from "@/application/services";
import { notifyAbout, receiveHook, recordOutreach, recordSignals, signalsOf, syncWorkspace, workspacesToSync } from "@/application/signals";
import { fromRegistry } from "@/domain/registry";
import { ProviderError } from "@/infrastructure/connectors/http";
import type { Database } from "@/infrastructure/db/client";
import { connection } from "@/infrastructure/db/schema/connections";
import { suppression } from "@/infrastructure/db/schema/prospects";
import { withWorkspace } from "@/infrastructure/db/tenant";
import type { Env } from "@/infrastructure/env";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { holding } from "./support/registry";

const adapter = { check: vi.fn(), notify: vi.fn(), signalsSince: vi.fn(), readWebhook: vi.fn() };
vi.mock("@/infrastructure/connectors", () => ({ adapterOf: () => () => adapter }));

const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: Buffer.alloc(32, 1).toString("base64") } as Env;
const now = new Date("2026-11-04T09:00:00Z");

let db: Database;
let services: Services;
beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => now };
});
beforeEach(() => {
  vi.resetAllMocks();
  adapter.check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
});

const reply = (externalId: string, overrides: Partial<Signal> = {}): Signal => ({ type: "replied", channel: "email", externalId, address: "ada@acme.fr", at: now, detail: "Bonjour", ...overrides });

/** Who these tests' workspaces wrote to: what concerns anyone else isn't kept. */
const REACHED = ["ada@acme.fr", "bob@acme.fr", "gone@acme.fr"];

async function connected(kind = "brevo_sms", fields: Record<string, string> = { apiKey: "k", sender: "S" }) {
  const seat = await createTestWorkspace(db);
  const result = await connectWithFields(services, seat.workspaceId, seat.userId, kind, fields);
  if (!result.ok) throw new Error(result.error);
  for (const address of REACHED) await recordOutreach(db, seat.workspaceId, { connectionId: result.connection.id, channel: "email", address, messageId: `<${address}>`, at: now });
  return { ...seat, connection: result.connection as ConnectionView };
}

describe("what comes back", () => {
  it("keeps each event once", async () => {
    const { workspaceId, connection: link } = await connected();
    expect(await recordSignals(db, workspaceId, link.id, [reply("1"), reply("2")])).toHaveLength(2);
    expect(await recordSignals(db, workspaceId, link.id, [reply("2"), reply("3")])).toHaveLength(1);
    expect(await signalsOf(db, workspaceId)).toHaveLength(3);
    expect(await recordSignals(db, workspaceId, link.id, [])).toEqual([]);
  });

  it("keeps nothing about someone the workspace never wrote to: a mailbox holds much else", async () => {
    const { workspaceId, connection: link } = await connected();
    const added = await recordSignals(db, workspaceId, link.id, [reply("friend", { address: "friend@gmail.test", detail: "On dîne samedi ?" }), reply("invoice", { type: "bounced", address: "billing@other.test" }), reply("guest", { type: "meeting_booked", channel: "calendar", address: "doctor@other.test" }), reply("nobody", { address: null })]);
    expect(added).toEqual([]);
    expect(await signalsOf(db, workspaceId)).toEqual([]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(suppression))).toEqual([]);
  });

  it("keeps a colleague's answer from another address, by the message it names", async () => {
    const { workspaceId, connection: link } = await connected();
    const added = await recordSignals(db, workspaceId, link.id, [reply("colleague", { address: "colleague@acme.fr", inReplyTo: "<ada@acme.fr>" }), reply("other-thread", { address: "colleague@acme.fr", inReplyTo: "<someone-elses@thread>" })]);
    expect(added.map((found) => found.externalId)).toEqual(["colleague"]);
  });

  it("honours a STOP from anyone, even someone it can't place", async () => {
    const { workspaceId, connection: link } = await connected();
    await recordSignals(db, workspaceId, link.id, [reply("stop", { type: "opted_out", channel: "sms", address: "+33699999999" })]);
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select({ value: suppression.value }).from(suppression))).toEqual([{ value: "+33699999999" }]);
  });

  it("matches the address however it was written when the workspace reached it", async () => {
    const { workspaceId, connection: link } = await connected();
    await recordOutreach(db, workspaceId, { connectionId: link.id, channel: "email", address: " Carol@ACME.fr ", at: now });
    expect(await recordSignals(db, workspaceId, link.id, [reply("carol", { address: "carol@acme.fr" })])).toHaveLength(1);
  });

  it("doesn't count one workspace's outreach for another", async () => {
    const mine = await connected();
    const seat = await createTestWorkspace(db, "Other");
    const result = await connectWithFields(services, seat.workspaceId, seat.userId, "brevo_sms", { apiKey: "k", sender: "S" });
    if (!result.ok) throw new Error(result.error);
    expect(await recordSignals(db, seat.workspaceId, result.connection.id, [reply("elsewhere")])).toEqual([]);
    expect(await recordSignals(db, mine.workspaceId, mine.connection.id, [reply("mine")])).toHaveLength(1);
  });

  it("puts a STOP and a bounce on the suppression list, not a reply", async () => {
    const { workspaceId, connection: link } = await connected();
    await recordSignals(db, workspaceId, link.id, [reply("1", { type: "opted_out", address: "+33612345678" }), reply("2", { type: "bounced", address: "gone@acme.fr" }), reply("3", { address: "ada@acme.fr" }), reply("4", { type: "opted_out", address: null })]);
    const list = await withWorkspace(db, workspaceId, (tx) => tx.select({ value: suppression.value, reason: suppression.reason }).from(suppression));
    expect(list).toEqual(expect.arrayContaining([{ value: "+33612345678", reason: "opted_out" }, { value: "gone@acme.fr", reason: "bounced" }]));
    expect(list).toHaveLength(2);
  });

  it("filters by date and kind, the latest first, and keeps them once the connection is gone", async () => {
    const { workspaceId, connection: link } = await connected();
    await recordSignals(db, workspaceId, link.id, [reply("old", { at: new Date("2026-10-01T00:00:00Z") }), reply("new"), reply("meeting", { type: "meeting_booked", channel: "calendar" })]);
    expect((await signalsOf(db, workspaceId, { since: new Date("2026-11-01T00:00:00Z") })).map((found) => found.type).sort()).toEqual(["meeting_booked", "replied"]);
    expect(await signalsOf(db, workspaceId, { types: ["meeting_booked"] })).toMatchObject([{ channel: "calendar", from: "Compte" }]);
    await withWorkspace(db, workspaceId, (tx) => tx.delete(connection).where(eq(connection.id, link.id)));
    expect(await signalsOf(db, workspaceId, { types: ["meeting_booked"] })).toMatchObject([{ from: "connexion retirée" }]);
  });

  it("hides one workspace's events from another", async () => {
    const mine = await connected();
    const theirs = await createTestWorkspace(db, "Other");
    await recordSignals(db, mine.workspaceId, mine.connection.id, [reply("1")]);
    expect(await signalsOf(db, theirs.workspaceId)).toEqual([]);
  });
});

describe("what a service posts", () => {
  const post = { method: "POST", url: "https://coldlyne.test/api/hooks/x", headers: new Headers(), body: "{}" };
  const tokenOf = (link: ConnectionView) => new URL(link.hookUrl as string).searchParams.get("token") as string;

  it("needs the connection's token, and doesn't say whether the connection exists", async () => {
    const { connection: link } = await connected();
    expect(await receiveHook(services, link.id, "wrong", post)).toEqual({ status: 404 });
    expect(await receiveHook(services, link.id, null, post)).toEqual({ status: 404 });
    expect(await receiveHook(services, crypto.randomUUID(), "any", post)).toEqual({ status: 404 });
    expect(adapter.readWebhook).not.toHaveBeenCalled();
  });

  it("refuses what the adapter finds forged", async () => {
    const { connection: link } = await connected();
    adapter.readWebhook.mockRejectedValue(new ProviderError("Twilio", 401, "Message non lu"));
    expect(await receiveHook(services, link.id, tokenOf(link), post)).toEqual({ status: 401, body: "Message non lu" });
    adapter.readWebhook.mockRejectedValue(new Error("Adresse invalide"));
    expect(await receiveHook(services, link.id, tokenOf(link), post)).toEqual({ status: 400, body: "Adresse invalide" });
  });

  it("keeps what it reads, and answers a provider's handshake as asked", async () => {
    const { workspaceId, connection: link } = await connected();
    adapter.readWebhook.mockResolvedValue({ signals: [reply("hook-1")] });
    expect(await receiveHook(services, link.id, tokenOf(link), post)).toEqual({ status: 200 });
    expect(await signalsOf(db, workspaceId)).toHaveLength(1);

    const challenge = new Response("challenge-value", { status: 200 });
    adapter.readWebhook.mockResolvedValue({ signals: [], reply: challenge });
    expect((await receiveHook(services, link.id, tokenOf(link), post)).response).toBe(challenge);
  });
});

describe("alerts", () => {
  it("tells alert connections about replies, meetings and sign-ups, not delivery reports", async () => {
    const { workspaceId } = await connected("slack", { webhookUrl: "https://hooks.slack.test/x" });
    await notifyAbout(services, workspaceId, [reply("1"), reply("2", { type: "delivered" }), reply("3", { type: "meeting_booked" }), reply("4", { type: "signed_up", address: null })]);
    expect(adapter.notify.mock.calls.map(([notification]) => notification.title)).toEqual(["ada@acme.fr a répondu", "ada@acme.fr a pris rendez-vous", "Quelqu’un s’est inscrit"]);
  });

  it("marks a failing alert connection instead of failing what triggered it", async () => {
    const { workspaceId, connection: link } = await connected("slack", { webhookUrl: "https://hooks.slack.test/x" });
    adapter.notify.mockRejectedValue(new Error("Slack refuse"));
    await notifyAbout(services, workspaceId, [reply("1")]);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection).where(eq(connection.id, link.id)));
    expect(row).toMatchObject({ status: "failing", lastError: "Slack refuse" });
  });
});

describe("a connection that starts failing", () => {
  const resend = { match: "POST https://api.resend.com/emails", json: { id: "email-1" } };

  it("mails the member who connected it each time it goes from working to failing, through Coldlyne's own mail", async () => {
    const { workspaceId } = await connected("slack", { webhookUrl: "https://hooks.slack.test/x" });
    const { fetch, calls } = fakeFetch([resend]);
    const mailing = { ...services, fetch, settings: { ...settings, RESEND_API_KEY: "re_test", COLDLYNE_MAIL_FROM: "Coldlyne <contact@coldlyne.com>" } };
    adapter.notify.mockRejectedValue(new Error("Slack refuse"));

    await notifyAbout(mailing, workspaceId, [reply("1")]);
    await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ status: "connected" }));
    await notifyAbout(mailing, workspaceId, [reply("2")]);

    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get("authorization")).toBe("Bearer re_test");
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ from: "Coldlyne <contact@coldlyne.com>", subject: "Coldlyne ne peut plus utiliser Compte" });
    expect(body.to[0]).toMatch(/@example\.test$/);
    expect(body.text).toContain("Slack refuse");
    expect(body.text).toContain("https://coldlyne.test/connections/slack");
  });

  it("doesn't mail again while it keeps failing, and sends nothing without a key", async () => {
    const { workspaceId } = await connected("smtp", { address: "a@b.fr", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p" });
    const { fetch, calls } = fakeFetch([resend]);
    adapter.signalsSince.mockRejectedValue(new Error("Refusé"));
    await syncWorkspace({ ...services, fetch }, workspaceId);
    expect(calls).toEqual([]);

    await withWorkspace(db, workspaceId, (tx) => tx.update(connection).set({ status: "connected" }));
    const mailing = { ...services, fetch, settings: { ...settings, RESEND_API_KEY: "re_test", COLDLYNE_MAIL_FROM: "Coldlyne <contact@coldlyne.com>" } };
    await syncWorkspace(mailing, workspaceId);
    expect(calls).toHaveLength(1);
    await syncWorkspace(mailing, workspaceId);
    expect(calls).toHaveLength(1);
  });

  it("isn't troubled by a mail that can't leave", async () => {
    const { workspaceId } = await connected("smtp", { address: "a@b.fr", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p" });
    adapter.signalsSince.mockRejectedValue(new Error("Refusé"));
    const down = { ...services, fetch: fakeFetch([{ match: "POST https://api.resend.com/emails", status: 500, json: {} }]).fetch, settings: { ...settings, RESEND_API_KEY: "re_test", COLDLYNE_MAIL_FROM: "x" } };
    expect(await syncWorkspace(down, workspaceId)).toEqual({ read: 0, added: 0, failing: ["Compte"] });
  });
});

describe("reading what arrived", () => {
  const mailbox = { address: "ada@northwind.fr", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p" };

  it("reads from a week back the first time, then from where it stopped, with a day's overlap", async () => {
    const { workspaceId } = await connected("smtp", mailbox);
    adapter.signalsSince.mockResolvedValue([reply("1")]);
    expect(await syncWorkspace(services, workspaceId)).toEqual({ read: 1, added: 1, failing: [] });
    expect(adapter.signalsSince.mock.calls[0][0]).toEqual(new Date("2026-10-27T09:00:00Z"));

    expect(await syncWorkspace(services, workspaceId)).toEqual({ read: 1, added: 0, failing: [] });
    expect(adapter.signalsSince.mock.calls[1][0]).toEqual(new Date("2026-11-03T09:00:00Z"));
  });

  it("marks a mailbox that fails, and lists it", async () => {
    const { workspaceId } = await connected("smtp", mailbox);
    adapter.signalsSince.mockRejectedValue(new Error("Mot de passe refusé"));
    expect(await syncWorkspace(services, workspaceId)).toEqual({ read: 0, added: 0, failing: ["Compte"] });
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row).toMatchObject({ status: "failing", lastError: "Mot de passe refusé" });
  });

  it("finds every workspace with something to read", async () => {
    const { workspaceId } = await connected("smtp", mailbox);
    expect(await workspacesToSync(db)).toContain(workspaceId);
  });
});

describe("keys other apps read figures with", () => {
  it("shows a key once, keeps its hash, finds its workspace and stops at revocation", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const made = await createApiKey(db, workspaceId, userId, "Tableau de bord");
    if (!made.ok) throw new Error(made.error);
    const { id, key } = made;
    expect(key.startsWith("cl_")).toBe(true);
    expect(await workspaceOfKey(db, key)).toBe(workspaceId);
    expect(await workspaceOfKey(db, "cl_wrong")).toBeNull();
    expect(await workspaceOfKey(db, "other")).toBeNull();
    expect(await workspaceOfKey(db, null)).toBeNull();
    const [listed] = await apiKeysOf(db, workspaceId);
    expect(listed).toMatchObject({ name: "Tableau de bord", prefix: key.slice(0, 10) });
    expect(listed.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(await revokeApiKey(db, workspaceId, userId, id)).toMatchObject({ ok: true });
    expect(await workspaceOfKey(db, key)).toBeNull();
  });

  it("counts prospects and what came back, without a name or an address", async () => {
    const { workspaceId, connection: link } = await connected();
    const list = await createList(db, workspaceId, "Holdings");
    await addFromRegistry(db, workspaceId, list, [fromRegistry(holding())]);
    await recordSignals(db, workspaceId, link.id, [reply("1"), reply("2", { address: "bob@acme.fr" }), reply("3", { type: "bounced", at: new Date("2026-11-03T12:00:00Z") })]);

    const figures = await figuresOf(db, workspaceId, new Date("2026-11-01T00:00:00Z"));

    expect(figures.prospects).toEqual([{ list: "Holdings", state: "new", count: 1 }]);
    expect(figures.sent).toEqual([{ day: "2026-11-04", channel: "email", count: REACHED.length }]);
    expect(figures.signals).toEqual([
      { day: "2026-11-03", channel: "email", type: "bounced", count: 1 },
      { day: "2026-11-04", channel: "email", type: "replied", count: 2 },
    ]);
    expect(JSON.stringify(figures)).not.toContain("acme.fr");
  });
});
