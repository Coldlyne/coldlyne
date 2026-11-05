import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finishOAuthConnection, startOAuthConnection } from "@/application/connection-grants";
import { factsOf, publishRecord, readNow, reputationOf, sendTestAlert, tryCheck, tryTestEmail } from "@/application/connection-use";
import { checkConnection, connectionsOf, connectorsOffered, connectWithFields, connectionsWith, disconnect, openConnection } from "@/application/connections";
import type { Services } from "@/application/services";
import { sendTestEmail } from "@/application/test-email";
import { connection } from "@/infrastructure/db/schema/connections";
import { member } from "@/infrastructure/db/schema/tenancy";
import type { Database } from "@/infrastructure/db/client";
import type { Env } from "@/infrastructure/env";
import { open } from "@/infrastructure/crypto/secrets";
import { withWorkspace } from "@/infrastructure/db/tenant";
import { createTestDatabase, createTestWorkspace } from "./support/database";
import { fakeFetch } from "./support/fetch";
import { expectFrenchTypography } from "./support/french";

/** An adapter whose answer each test decides; the real ones are tested against their providers' shapes. */
const check = vi.fn();
const seen: { fields?: Record<string, string>; token?: () => Promise<string> } = {};
const ports: Partial<Record<"sendEmail" | "notify" | "signalsSince" | "upsertRecord" | "reputation" | "company", ReturnType<typeof vi.fn>>> = {};
vi.mock("@/infrastructure/connectors", () => ({
  adapterOf: () => (context: { fields: Record<string, string>; accessToken: () => Promise<string> }) => {
    seen.fields = { ...context.fields };
    seen.token = context.accessToken;
    return { check, ...ports };
  },
}));

const KEY = Buffer.alloc(32, 1).toString("base64");
const settings = { BETTER_AUTH_URL: "https://coldlyne.test", COLDLYNE_SECRETS_KEY: KEY, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" } as Env;

let db: Database;
let services: Services;
const now = new Date("2026-11-04T09:00:00Z");

beforeAll(async () => {
  db = await createTestDatabase();
  services = { db, settings, fetch: fakeFetch([]).fetch, now: () => now };
});
beforeEach(() => {
  check.mockReset();
});

const brevo = { apiKey: "the-key", sender: "NORTHWIND" };

describe("connecting with fields", () => {
  it("checks with the service first, seals the secrets, and shows them nowhere", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte Northwind" });

    const result = await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo);

    expect(result).toMatchObject({ ok: true, connection: { kind: "brevo_sms", label: "Compte Northwind", status: "connected", name: "Brevo" } });
    expect(JSON.stringify(result)).not.toContain("the-key");
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row.sealedCredentials).not.toContain("the-key");
    expect(open(row.sealedCredentials, KEY)).toEqual({ apiKey: "the-key" });
    expect(row.settings).toEqual({ sender: "NORTHWIND" });
    expect(row.connectedBy).toBe(userId);
  });

  it("saves nothing when the service refuses, and says why", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: false, detail: "Brevo a refusé les identifiants." });
    expect(await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo)).toEqual({ ok: false, error: "Brevo a refusé les identifiants." });
    expect(await connectionsOf(services, workspaceId)).toEqual([]);
  });

  it("treats a service that throws as a refusal", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockRejectedValue(new Error("Injoignable"));
    expect(await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo)).toEqual({ ok: false, error: "Injoignable" });
  });

  it("says what is missing, and refuses a connector that signs in", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    const missing = await connectWithFields(services, workspaceId, userId, "brevo_sms", { sender: "NORTHWIND" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("Clé d’API");
    expect((await connectWithFields(services, workspaceId, userId, "gmail", {})).ok).toBe(false);
    expect((await connectWithFields(services, workspaceId, userId, "unknown", {})).ok).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("replaces the credentials when the same account connects again, keeping its hook address", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
    const first = await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo);
    const second = await connectWithFields(services, workspaceId, userId, "brevo_sms", { ...brevo, apiKey: "new-key" });
    if (!first.ok || !second.ok) throw new Error("expected both to connect");
    expect(second.connection.id).toBe(first.connection.id);
    expect(second.connection.hookUrl).toBe(first.connection.hookUrl);
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(open(row.sealedCredentials, KEY).apiKey).toBe("new-key");
  });

  it("gives the adapter secret and plain fields together, and a hook address to connectors that post", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
    const result = await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo);
    if (!result.ok) throw new Error("expected to connect");
    expect(result.connection.hookUrl).toMatch(/^https:\/\/coldlyne\.test\/api\/hooks\/[0-9a-f-]{36}\?token=/);
    await openConnection(services, workspaceId, result.connection.id);
    expect(seen.fields).toEqual(brevo);
  });

  it("gives no hook address to a connector that doesn't post", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "HubSpot" });
    const result = await connectWithFields(services, workspaceId, userId, "hubspot", { accessToken: "t" });
    expect(result).toMatchObject({ ok: true, connection: { hookUrl: null } });
  });
});

describe("a connection's life", () => {
  it("records a failing check with its reason, and a recovery", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
    const result = await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo);
    if (!result.ok) throw new Error("expected to connect");

    check.mockResolvedValue({ ok: false, detail: "Clé révoquée" });
    expect(await checkConnection(services, workspaceId, result.connection.id)).toMatchObject({ status: "failing", lastError: "Clé révoquée" });
    expect(await connectionsWith(services, workspaceId, "send_sms")).toEqual([]);

    check.mockResolvedValue({ ok: true, detail: "ok" });
    expect(await checkConnection(services, workspaceId, result.connection.id)).toMatchObject({ status: "connected", lastError: null });
    expect(await connectionsWith(services, workspaceId, "send_sms")).toHaveLength(1);
    expect(await connectionsWith(services, workspaceId, "send_email")).toEqual([]);
  });

  it("forgets a disconnected connection", async () => {
    const { workspaceId, userId } = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
    const result = await connectWithFields(services, workspaceId, userId, "brevo_sms", brevo);
    if (!result.ok) throw new Error("expected to connect");
    expect(await disconnect(services, workspaceId, result.connection.id)).toBe(true);
    expect(await disconnect(services, workspaceId, result.connection.id)).toBe(false);
    expect(await checkConnection(services, workspaceId, result.connection.id)).toBeNull();
  });

  it("keeps workspaces apart", async () => {
    const mine = await createTestWorkspace(db);
    const theirs = await createTestWorkspace(db, "Other");
    check.mockResolvedValue({ ok: true, detail: "ok", label: "Compte" });
    const result = await connectWithFields(services, mine.workspaceId, mine.userId, "brevo_sms", brevo);
    if (!result.ok) throw new Error("expected to connect");
    expect(await connectionsOf(services, theirs.workspaceId)).toEqual([]);
    expect(await openConnection(services, theirs.workspaceId, result.connection.id)).toBeNull();
    expect(await disconnect(services, theirs.workspaceId, result.connection.id)).toBe(false);
    expect(await connectionsOf(services, mine.workspaceId)).toHaveLength(1);
  });
});

describe("connecting by signing in", () => {
  const tokenRoute = { match: "POST https://oauth2.googleapis.com/token", json: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s" } };

  async function started() {
    const seat = await createTestWorkspace(db);
    const start = await startOAuthConnection(services, seat.workspaceId, seat.userId, "gmail");
    if (!start.ok) throw new Error(start.error);
    return { ...seat, state: new URL(start.url).searchParams.get("state") as string };
  }

  it("finishes for the member who started, naming the mailbox from the service's answer", async () => {
    const { workspaceId, userId, state } = await started();
    check.mockResolvedValue({ ok: true, detail: "ok", label: "ada@northwind.fr" });
    const result = await finishOAuthConnection({ ...services, fetch: fakeFetch([tokenRoute]).fetch }, userId, state, "code");
    expect(result).toMatchObject({ ok: true, workspaceId, connection: { kind: "gmail", label: "ada@northwind.fr" } });
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row.settings).toEqual({ address: "ada@northwind.fr" });
    expect(open(row.sealedCredentials, KEY)).toMatchObject({ accessToken: "at", refreshToken: "rt" });
  });

  it("refuses someone else's grant, a used one, and an expired one", async () => {
    const stolen = await started();
    expect((await finishOAuthConnection(services, "someone-else", stolen.state, "code")).ok).toBe(false);
    expect((await finishOAuthConnection(services, stolen.userId, stolen.state, "code")).ok).toBe(false);

    const late = await started();
    const later = { ...services, now: () => new Date(now.getTime() + 11 * 60_000) };
    expect((await finishOAuthConnection(later, late.userId, late.state, "code")).ok).toBe(false);
  });

  it("refuses someone taken out of the workspace while they were at the provider", async () => {
    const { workspaceId, userId, state } = await started();
    await db.delete(member).where(eq(member.userId, userId));
    expect(await finishOAuthConnection({ ...services, fetch: fakeFetch([tokenRoute]).fetch }, userId, state, "code")).toMatchObject({ ok: false });
    expect(await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection))).toEqual([]);
  });

  it("refreshes an expired token and saves the new one, sealed", async () => {
    const { workspaceId, userId, state } = await started();
    check.mockResolvedValue({ ok: true, detail: "ok", label: "ada@northwind.fr" });
    const finished = await finishOAuthConnection({ ...services, fetch: fakeFetch([tokenRoute]).fetch }, userId, state, "code");
    if (!finished.ok) throw new Error(finished.error);

    const later = { ...services, now: () => new Date(now.getTime() + 2 * 3_600_000), fetch: fakeFetch([{ ...tokenRoute, json: { access_token: "fresh", expires_in: 3600 } }]).fetch };
    await openConnection(later, workspaceId, finished.connection.id);
    expect(await seen.token?.()).toBe("fresh");
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(open(row.sealedCredentials, KEY)).toMatchObject({ accessToken: "fresh", refreshToken: "rt" });
  });

  it("says when the instance has no app with the provider", async () => {
    const seat = await createTestWorkspace(db);
    const result = await startOAuthConnection(services, seat.workspaceId, seat.userId, "microsoft365");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Microsoft");
    expect((await startOAuthConnection(services, seat.workspaceId, seat.userId, "brevo_sms")).ok).toBe(false);
  });
});

describe("what an instance offers", () => {
  const SIGNED_IN = { google: ["gmail", "google_calendar", "google_sheets", "postmaster"], microsoft: ["microsoft365", "microsoft_calendar"] };
  const offered = (given: Partial<Env>) => connectorsOffered({ BETTER_AUTH_URL: "https://coldlyne.test", ...given } as Env).map((connector) => connector.kind as string);

  it("leaves out what signs in through an app the instance hasn't registered", () => {
    const kinds = offered({});
    for (const kind of [...SIGNED_IN.google, ...SIGNED_IN.microsoft]) expect(kinds).not.toContain(kind);
    expect(kinds).toEqual(expect.arrayContaining(["smtp", "hubspot", "slack"]));
  });

  it("offers them once it has, one provider at a time", () => {
    const withGoogle = offered({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" });
    expect(withGoogle).toEqual(expect.arrayContaining(SIGNED_IN.google));
    for (const kind of SIGNED_IN.microsoft) expect(withGoogle).not.toContain(kind);
    expect(offered({ MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "s" })).toEqual(expect.arrayContaining(SIGNED_IN.microsoft));
  });
});

describe("trying a connection", () => {
  async function slack() {
    const seat = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "#ventes" });
    const connected = await connectWithFields(services, seat.workspaceId, seat.userId, "slack", { webhookUrl: "https://hooks.slack.test/x" });
    if (!connected.ok) throw new Error(connected.error);
    return { ...seat, connectionId: connected.connection.id };
  }
  beforeEach(() => {
    for (const port of Object.keys(ports) as (keyof typeof ports)[]) delete ports[port];
  });

  it("says an alert left, and why not when the service refuses", async () => {
    const { workspaceId, connectionId } = await slack();
    expect((await sendTestAlert(services, workspaceId, connectionId)).ok).toBe(false);
    ports.notify = vi.fn().mockResolvedValue(undefined);
    expect(await sendTestAlert(services, workspaceId, connectionId)).toEqual({ ok: true, said: "Alerte envoyée par #ventes." });
    expect(ports.notify.mock.calls[0][0]).toMatchObject({ event: "test" });
    ports.notify = vi.fn().mockRejectedValue(new Error("Canal archivé"));
    expect(await sendTestAlert(services, workspaceId, connectionId)).toEqual({ ok: false, error: "Canal archivé" });
  });

  it("reads now, and explains why what it read wasn't kept", async () => {
    const { workspaceId, connectionId } = await slack();
    expect((await readNow(services, workspaceId, connectionId)).ok).toBe(false);
    ports.signalsSince = vi.fn().mockResolvedValue([{ type: "replied", channel: "email", externalId: "a", address: "stranger@acme.fr", at: now }]);
    expect(await readNow(services, workspaceId, connectionId)).toEqual({ ok: true, said: "1 élément lu, 0 nouveau retenu. Coldlyne ne garde que ce qui concerne les personnes que vous avez contactées." });
    const [row] = await withWorkspace(db, workspaceId, (tx) => tx.select().from(connection));
    expect(row.syncedAt).toEqual(now);
  });

  it("says why a read failed, and marks the connection", async () => {
    const { workspaceId, connectionId } = await slack();
    ports.signalsSince = vi.fn().mockRejectedValue(new Error("Boîte verrouillée"));
    expect(await readNow(services, workspaceId, connectionId)).toEqual({ ok: false, error: "Boîte verrouillée" });
    const [view] = await connectionsOf(services, workspaceId);
    expect(view).toMatchObject({ status: "failing", lastError: "Boîte verrouillée" });
  });

  it("says whether the service still answers", async () => {
    const { workspaceId, connectionId } = await slack();
    expect(await tryCheck(services, workspaceId, connectionId)).toEqual({ ok: true, said: "#ventes répond." });
    check.mockResolvedValue({ ok: false, detail: "Adresse révoquée" });
    expect(await tryCheck(services, workspaceId, connectionId)).toEqual({ ok: false, error: "Adresse révoquée" });
    expect((await tryCheck(services, workspaceId, "00000000-0000-4000-8000-000000000000")).ok).toBe(false);
  });

  it("publishes through a DNS, and says what its service answered", async () => {
    const { workspaceId, connectionId } = await slack();
    const record = { type: "TXT" as const, name: "_dmarc", value: "v=DMARC1; p=none" };
    expect((await publishRecord(services, workspaceId, connectionId, "acme.fr", record)).ok).toBe(false);
    ports.upsertRecord = vi.fn().mockResolvedValue(undefined);
    expect((await publishRecord(services, workspaceId, connectionId, "acme.fr", record)).ok).toBe(true);
    expect(ports.upsertRecord).toHaveBeenCalledWith("acme.fr", record);
    ports.upsertRecord = vi.fn().mockRejectedValue(new Error("Zone inconnue"));
    expect(await publishRecord(services, workspaceId, connectionId, "acme.fr", record)).toEqual({ ok: false, error: "Zone inconnue" });
  });

  it("reads a domain's reputation, and says what its service answered", async () => {
    const { workspaceId, connectionId } = await slack();
    expect((await reputationOf(services, workspaceId, connectionId, "acme.fr", 30)).ok).toBe(false);
    const days = [{ date: "2026-11-03", reputation: null, spamRate: 0.001 }];
    ports.reputation = vi.fn().mockResolvedValue(days);
    expect(await reputationOf(services, workspaceId, connectionId, "acme.fr", 30)).toEqual({ ok: true, days });
    ports.reputation = vi.fn().mockRejectedValue(new Error("Domaine inconnu"));
    expect(await reputationOf(services, workspaceId, connectionId, "acme.fr", 30)).toEqual({ ok: false, error: "Domaine inconnu" });
  });

  it("asks a source about a company, by a real SIREN", async () => {
    const { workspaceId, connectionId } = await slack();
    expect((await factsOf(services, workspaceId, connectionId, "12345")).ok).toBe(false);
    expect((await factsOf(services, workspaceId, connectionId, "123456789")).ok).toBe(false);
    const facts = { siren: "123456789", name: "ACME", facts: { headcount: "10-19" } };
    ports.company = vi.fn().mockResolvedValue(facts);
    expect(await factsOf(services, workspaceId, connectionId, "123456789")).toEqual({ ok: true, facts });
    ports.company = vi.fn().mockResolvedValue(null);
    expect(await factsOf(services, workspaceId, connectionId, "123456789")).toEqual({ ok: false, error: "Cette source ne connaît pas le SIREN 123456789." });
    ports.company = vi.fn().mockRejectedValue(new Error("Quota atteint"));
    expect(await factsOf(services, workspaceId, connectionId, "123456789")).toEqual({ ok: false, error: "Quota atteint" });
  });

  it("sends the member a test, and passes on a refusal", async () => {
    const { workspaceId, userId, connectionId } = await slack();
    expect((await tryTestEmail(services, workspaceId, userId, connectionId)).ok).toBe(false);
    ports.sendEmail = vi.fn().mockResolvedValue({ externalId: "1" });
    const tried = await tryTestEmail(services, workspaceId, userId, connectionId);
    expect(tried).toMatchObject({ ok: true, said: expect.stringContaining(`${userId}@example.test`) });
    expectFrenchTypography((tried as { said: string }).said.replace(`${userId}@example.test`, "ici"));
  });
});

describe("a test email", () => {
  async function mailbox() {
    const seat = await createTestWorkspace(db);
    check.mockResolvedValue({ ok: true, detail: "ok", label: "ada@northwind.fr" });
    const connected = await connectWithFields(services, seat.workspaceId, seat.userId, "smtp", { address: "ada@northwind.fr", smtpHost: "h", smtpPort: "465", imapHost: "h", imapPort: "993", password: "p" });
    if (!connected.ok) throw new Error(connected.error);
    return { ...seat, connectionId: connected.connection.id };
  }

  it("goes to the member who asks, and to no one else", async () => {
    const { workspaceId, userId, connectionId } = await mailbox();
    ports.sendEmail = vi.fn().mockResolvedValue({ externalId: "1" });
    const sent = await sendTestEmail(services, workspaceId, userId, connectionId);
    expect(sent).toEqual({ ok: true, to: `${userId}@example.test`, from: "ada@northwind.fr" });
    expect(ports.sendEmail).toHaveBeenCalledTimes(1);
    expect(ports.sendEmail.mock.calls[0][0]).toMatchObject({ to: `${userId}@example.test`, subject: "Test Coldlyne" });
  });

  it("says why when the mailbox can't send", async () => {
    const { workspaceId, userId, connectionId } = await mailbox();
    ports.sendEmail = vi.fn().mockRejectedValue(new Error("Mot de passe refusé"));
    expect(await sendTestEmail(services, workspaceId, userId, connectionId)).toEqual({ ok: false, error: "Mot de passe refusé" });
  });

  it("refuses a connection that doesn't send email, and another workspace's", async () => {
    const { workspaceId, userId, connectionId } = await mailbox();
    ports.sendEmail = undefined;
    expect((await sendTestEmail(services, workspaceId, userId, connectionId)).ok).toBe(false);
    ports.sendEmail = vi.fn();
    const other = await createTestWorkspace(db, "Other");
    expect((await sendTestEmail(services, other.workspaceId, other.userId, connectionId)).ok).toBe(false);
    expect(ports.sendEmail).not.toHaveBeenCalled();
  });
});
