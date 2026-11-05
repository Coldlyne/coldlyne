import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InboundRequest } from "@/application/ports";
import { adapterOf } from "@/infrastructure/connectors";
import { everyPage } from "@/infrastructure/connectors/pages";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";
import { expectFrenchTypography } from "../support/french";

const SINCE = new Date("2026-11-01T00:00:00Z");
const HOOK_SECRET = "hook-token";

const hmac = (signed: string, secret = HOOK_SECRET) => createHmac("sha256", secret).update(signed).digest("hex");
const inbound = (body: string, headers: Record<string, string>): InboundRequest => ({ method: "POST", url: "https://coldlyne.test/api/hooks/x", headers: new Headers(headers), body });

function client(kind: Parameters<typeof adapterOf>[0], fields: Record<string, string>, routes: FakeRoute[]) {
  const fake = fakeFetch(routes);
  return { connection: adapterOf(kind)(adapterContext(fields, fake.fetch)), calls: fake.calls };
}

describe("everyPage", () => {
  it("stops when the provider gives no next cursor, and passes each cursor on", async () => {
    const seen: (string | undefined)[] = [];
    const pages = await everyPage(
      async (cursor) => {
        seen.push(cursor);
        return cursor ? { next: null } : { next: "second" };
      },
      (page) => page.next,
    );
    expect(pages).toHaveLength(2);
    expect(seen).toEqual([undefined, "second"]);
  });

  it("gives up on a provider that repeats its cursor forever", async () => {
    const pages = await everyPage(
      async () => ({ next: "again" }),
      (page) => page.next,
    );
    expect(pages.length).toBeLessThanOrEqual(500);
  });
});

describe("Google Agenda", () => {
  const USERINFO = "GET https://openidconnect.googleapis.com/v1/userinfo";
  const EVENTS = "GET https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const account = { match: USERINFO, json: { email: "Marie@Northwind.fr" } };

  it("checks the account and that it can read the calendar, named after its email", async () => {
    const { connection, calls } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [] } }]);

    expect(await connection.check()).toEqual({ ok: true, detail: "Agenda de Marie@Northwind.fr", label: "Marie@Northwind.fr" });
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([USERINFO, `${EVENTS}?maxResults=1`]);
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
    expect(calls[1].headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("says when Google refuses the token", async () => {
    const { connection } = client("google_calendar", {}, [{ match: USERINFO, status: 401, json: { error: "invalid_token" } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Google Agenda a refusé les identifiants : invalid_token" });
  });

  it("refuses to go on without the account's address, rather than count colleagues as prospects", async () => {
    const { connection } = client("google_calendar", {}, [{ match: USERINFO, json: {} }]);
    const check = await connection.check();
    expect(check.ok).toBe(false);
    expectFrenchTypography(check.detail);
  });

  it("asks for the events changed since then, deleted ones and occurrences included", async () => {
    const { connection, calls } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [] } }]);

    await connection.meetingsSince!(SINCE);

    expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({ updatedMin: "2026-11-01T00:00:00.000Z", showDeleted: "true", singleEvents: "true", maxResults: "250" });
  });

  it("gives one signal per outside guest, lowercased, with the event's title and start", async () => {
    const event = {
      id: "evt1",
      summary: "Démo Northwind",
      created: "2026-11-02T10:00:00Z",
      updated: "2026-11-03T10:00:00Z",
      start: { dateTime: "2026-11-12T15:00:00+01:00" },
      attendees: [
        { email: "marie@northwind.fr", self: true },
        { email: "marie@northwind.fr" },
        { email: "Jeanne@Acme.fr" },
        { email: "paul@globex.fr" },
        { email: "salle@resource.calendar.google.com", resource: true },
      ],
    };
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [event] } }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_booked", channel: "calendar", externalId: "evt1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
      { type: "meeting_booked", channel: "calendar", externalId: "evt1:paul@globex.fr", address: "paul@globex.fr", at: new Date("2026-11-02T10:00:00Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
  });

  it("leaves out events with colleagues only", async () => {
    const internal = { id: "evt2", summary: "Point d’équipe", attendees: [{ email: "marie@northwind.fr", self: true }, { email: "marie@northwind.fr" }] };
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [internal] } }]);
    expect(await connection.meetingsSince!(SINCE)).toEqual([]);
  });

  it("reads a cancelled event as a cancellation at its last change, under its own id", async () => {
    const cancelled = { id: "evt3", status: "cancelled", summary: "Démo", created: "2026-10-01T10:00:00Z", updated: "2026-11-03T08:00:00Z", start: { date: "2026-11-20" }, attendees: [{ email: "jeanne@acme.fr" }] };
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [cancelled] } }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_cancelled", channel: "calendar", externalId: "evt3:jeanne@acme.fr:cancelled", address: "jeanne@acme.fr", at: new Date("2026-11-03T08:00:00Z"), detail: "Démo, le 20 novembre 2026" },
    ]);
  });

  it("gives nothing for a deleted event that kept only its id, since no guest can be named", async () => {
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [{ id: "evt4", status: "cancelled" }] } }]);
    expect(await connection.meetingsSince!(SINCE)).toEqual([]);
  });

  it("reads a guest's refusal as a cancellation for that guest only", async () => {
    const event = { id: "evt5", created: "2026-11-02T10:00:00Z", updated: "2026-11-03T10:00:00Z", attendees: [{ email: "jeanne@acme.fr", responseStatus: "declined" }, { email: "paul@globex.fr", responseStatus: "accepted" }] };
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [event] } }]);

    const signals = await connection.meetingsSince!(SINCE);

    expect(signals.map(({ type, address }) => [type, address])).toEqual([
      ["meeting_booked", "paul@globex.fr"],
      ["meeting_cancelled", "jeanne@acme.fr"],
    ]);
    expect(signals[0].detail).toBe("Rendez-vous sans titre");
  });

  it("counts a weekly meeting once, under its series", async () => {
    const occurrence = (day: string) => ({ id: `series_${day}`, recurringEventId: "series", summary: "Suivi", created: "2026-11-02T10:00:00Z", attendees: [{ email: "jeanne@acme.fr" }], start: { dateTime: `2026-11-${day}T10:00:00Z` } });
    const { connection } = client("google_calendar", {}, [account, { match: EVENTS, json: { items: [occurrence("10"), occurrence("17"), occurrence("24")] } }]);

    const signals = await connection.meetingsSince!(SINCE);

    expect(signals.map(({ externalId }) => externalId)).toEqual(["series:jeanne@acme.fr"]);
  });

  it("says a broken network in the member's words, never as a raw error", async () => {
    const broken = adapterOf("google_calendar")(
      adapterContext({}, (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    );
    expect(await broken.check()).toEqual({ ok: false, detail: "Google Agenda ne répond pas correctement pour le moment." });
  });

  it("follows the next pages", async () => {
    const guest = (id: string) => ({ id, created: "2026-11-02T10:00:00Z", attendees: [{ email: "jeanne@acme.fr" }] });
    const { connection, calls } = client("google_calendar", {}, [
      account,
      { match: `${EVENTS}?updatedMin=2026-11-01T00%3A00%3A00.000Z&showDeleted=true&singleEvents=true&maxResults=250&pageToken=two`, json: { items: [guest("b")] } },
      { match: EVENTS, json: { items: [guest("a")], nextPageToken: "two" } },
    ]);

    const signals = await connection.meetingsSince!(SINCE);

    expect(signals.map(({ externalId }) => externalId)).toEqual(["a:jeanne@acme.fr", "b:jeanne@acme.fr"]);
    expect(calls).toHaveLength(3);
  });

  it("doesn't take two strangers on the same public mailbox service for colleagues", async () => {
    const event = { id: "evt6", created: "2026-11-02T10:00:00Z", attendees: [{ email: "jeanne@gmail.com" }, { email: "me@gmail.com", self: true }] };
    const { connection } = client("google_calendar", {}, [{ match: USERINFO, json: { email: "me@gmail.com" } }, { match: EVENTS, json: { items: [event] } }]);
    expect((await connection.meetingsSince!(SINCE)).map(({ address }) => address)).toEqual(["jeanne@gmail.com"]);
  });
});

describe("Agenda Outlook", () => {
  const ME = "GET https://graph.microsoft.com/v1.0/me?";
  const EVENTS = "GET https://graph.microsoft.com/v1.0/me/events";
  const account = { match: ME, json: { displayName: "Marie Durand", mail: "marie@northwind.fr", userPrincipalName: "marie@northwind.onmicrosoft.com" } };

  it("checks the account and the calendar permission, named after the mailbox", async () => {
    const { connection, calls } = client("microsoft_calendar", {}, [account, { match: EVENTS, json: { value: [] } }]);

    expect(await connection.check()).toEqual({ ok: true, detail: "Agenda de Marie Durand", label: "marie@northwind.fr" });
    expect(calls.map(({ url }) => url)).toEqual(["https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", "https://graph.microsoft.com/v1.0/me/events?$top=1&$select=id"]);
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("falls back on the principal name when the account has no mail", async () => {
    const { connection } = client("microsoft_calendar", {}, [{ match: ME, json: { displayName: null, mail: null, userPrincipalName: "marie@northwind.onmicrosoft.com" } }, { match: EVENTS, json: { value: [] } }]);
    expect(await connection.check()).toMatchObject({ ok: true, label: "marie@northwind.onmicrosoft.com" });
  });

  it("says when Graph refuses the token, with its own message", async () => {
    const { connection } = client("microsoft_calendar", {}, [{ match: ME, status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Agenda Outlook a refusé les identifiants : Access token has expired." });
  });

  it("asks for the events modified since then", async () => {
    const { connection, calls } = client("microsoft_calendar", {}, [account, { match: EVENTS, json: { value: [] } }]);

    await connection.meetingsSince!(SINCE);

    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/me/events?$top=50&$filter=lastModifiedDateTime%20ge%202026-11-01T00%3A00%3A00.000Z");
  });

  it("gives one signal per outside guest, reading Graph's start times as UTC", async () => {
    const event = {
      id: "AAMk1",
      subject: "Démo Northwind",
      createdDateTime: "2026-11-02T10:00:00Z",
      lastModifiedDateTime: "2026-11-03T10:00:00Z",
      start: { dateTime: "2026-11-12T14:00:00.0000000", timeZone: "UTC" },
      attendees: [
        { type: "required", emailAddress: { address: "Marie@northwind.fr" } },
        { type: "required", emailAddress: { address: "marie@northwind.fr" } },
        { type: "required", emailAddress: { address: "Jeanne@Acme.fr" }, status: { response: "accepted" } },
        { type: "resource", emailAddress: { address: "salle@acme.fr" } },
      ],
    };
    const { connection } = client("microsoft_calendar", {}, [account, { match: EVENTS, json: { value: [event] } }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_booked", channel: "calendar", externalId: "AAMk1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
  });

  it("leaves out internal meetings and unsent drafts, and includes cancellations and refusals", async () => {
    const internal = { id: "a", attendees: [{ type: "required", emailAddress: { address: "marie@northwind.fr" } }] };
    const draft = { id: "b", isDraft: true, attendees: [{ type: "required", emailAddress: { address: "draft@acme.fr" } }] };
    const cancelled = { id: "c", isCancelled: true, lastModifiedDateTime: "2026-11-03T10:00:00Z", attendees: [{ type: "required", emailAddress: { address: "jeanne@acme.fr" } }] };
    const refused = { id: "d", lastModifiedDateTime: "2026-11-03T11:00:00Z", attendees: [{ type: "required", status: { response: "declined" }, emailAddress: { address: "paul@globex.fr" } }] };
    const { connection } = client("microsoft_calendar", {}, [account, { match: EVENTS, json: { value: [internal, draft, cancelled, refused] } }]);

    const signals = await connection.meetingsSince!(SINCE);

    expect(signals.map(({ type, externalId }) => [type, externalId])).toEqual([
      ["meeting_cancelled", "c:jeanne@acme.fr:cancelled"],
      ["meeting_cancelled", "d:paul@globex.fr:cancelled"],
    ]);
  });

  it("follows @odata.nextLink", async () => {
    const guest = (id: string) => ({ id, createdDateTime: "2026-11-02T10:00:00Z", attendees: [{ type: "required", emailAddress: { address: "jeanne@acme.fr" } }] });
    const { connection, calls } = client("microsoft_calendar", {}, [
      account,
      { match: `${EVENTS}?$skip=50`, json: { value: [guest("b")] } },
      { match: EVENTS, json: { value: [guest("a")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/events?$skip=50" } },
    ]);

    expect((await connection.meetingsSince!(SINCE)).map(({ externalId }) => externalId)).toEqual(["a:jeanne@acme.fr", "b:jeanne@acme.fr"]);
    expect(calls[2].url).toBe("https://graph.microsoft.com/v1.0/me/events?$skip=50");
  });
});

describe("Cal.com", () => {
  const FIELDS = { apiKey: "cal_key" };
  const ME = "GET https://api.cal.com/v2/me";
  const CREATED = "GET https://api.cal.com/v2/bookings?afterCreatedAt";
  const UPDATED = "GET https://api.cal.com/v2/bookings?afterUpdatedAt";
  const account = { match: ME, json: { status: "success", data: { email: "marie@northwind.fr", name: "Marie" } } };
  const noBookings = { json: { status: "success", data: [], pagination: { hasMore: false, nextCursor: null } } };
  const page = (data: unknown[]) => ({ json: { status: "success", data, pagination: { hasMore: false, nextCursor: null } } });
  const booking = (overrides: object) => ({ uid: "bk1", title: "Démo Northwind", status: "accepted", start: "2026-11-12T14:00:00Z", createdAt: "2026-11-02T10:00:00Z", updatedAt: null, attendees: [{ name: "Jeanne", email: "Jeanne@Acme.fr" }], ...overrides });

  it("checks the key, without the version header /me doesn't document", async () => {
    const { connection, calls } = client("calcom", FIELDS, [account]);

    expect(await connection.check()).toEqual({ ok: true, detail: "Compte Marie", label: "marie@northwind.fr" });
    expect(calls[0].url).toBe("https://api.cal.com/v2/me");
    expect(calls[0].headers.get("authorization")).toBe("Bearer cal_key");
    expect(calls[0].headers.has("cal-api-version")).toBe(false);
  });

  it("says when Cal.com refuses the key", async () => {
    const { connection } = client("calcom", FIELDS, [{ match: ME, status: 401, json: { status: "error", error: { message: "Invalid API key" } } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Cal.com a refusé les identifiants : Invalid API key" });
  });

  it("asks for the bookings created and those updated since then, with the required version", async () => {
    const { connection, calls } = client("calcom", FIELDS, [account, { match: CREATED, ...noBookings }, { match: UPDATED, ...noBookings }]);

    await connection.meetingsSince!(SINCE);

    const asked = calls.slice(1).map(({ url }) => Object.fromEntries(new URL(url).searchParams));
    expect(asked).toEqual([
      { afterCreatedAt: "2026-11-01T00:00:00.000Z", limit: "100" },
      { afterUpdatedAt: "2026-11-01T00:00:00.000Z", limit: "100" },
    ]);
    expect(calls[1].headers.get("cal-api-version")).toBe("2026-05-01");
    expect(calls[2].headers.get("cal-api-version")).toBe("2026-05-01");
    expect(calls[1].headers.get("authorization")).toBe("Bearer cal_key");
  });

  it("gives one signal per outside guest, each booking only once whichever list it came from", async () => {
    const { connection } = client("calcom", FIELDS, [account, { match: CREATED, ...page([booking({})]) }, { match: UPDATED, ...page([booking({})]) }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_booked", channel: "calendar", externalId: "bk1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
  });

  it("leaves out internal bookings, waiting and refused ones, and the old side of a reschedule", async () => {
    const list = [
      booking({ uid: "internal", attendees: [{ email: "marie@northwind.fr" }] }),
      booking({ uid: "waiting", status: "pending" }),
      booking({ uid: "refused", status: "rejected" }),
      booking({ uid: "moved", status: "cancelled", rescheduledToUid: "new", updatedAt: "2026-11-03T10:00:00Z" }),
    ];
    const { connection } = client("calcom", FIELDS, [account, { match: CREATED, ...page(list) }, { match: UPDATED, ...noBookings }]);
    expect(await connection.meetingsSince!(SINCE)).toEqual([]);
  });

  it("includes cancellations, at the moment they changed", async () => {
    const { connection } = client("calcom", FIELDS, [account, { match: CREATED, ...noBookings }, { match: UPDATED, ...page([booking({ status: "cancelled", updatedAt: "2026-11-03T10:00:00Z" })]) }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_cancelled", channel: "calendar", externalId: "bk1:jeanne@acme.fr:cancelled", address: "jeanne@acme.fr", at: new Date("2026-11-03T10:00:00Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
  });

  it("walks the cursor while there is more", async () => {
    const { connection, calls } = client("calcom", FIELDS, [
      account,
      { match: "GET https://api.cal.com/v2/bookings?afterCreatedAt=2026-11-01T00%3A00%3A00.000Z&limit=100&cursor=next", ...page([booking({ uid: "b" })]) },
      { match: CREATED, json: { data: [booking({ uid: "a" })], pagination: { hasMore: true, nextCursor: "next" } } },
      { match: UPDATED, ...noBookings },
    ]);

    expect((await connection.meetingsSince!(SINCE)).map(({ externalId }) => externalId)).toEqual(["a:jeanne@acme.fr", "b:jeanne@acme.fr"]);
    expect(calls).toHaveLength(4);
  });

  describe("webhooks", () => {
    const delivery = (triggerEvent: string, payload: object = {}) =>
      JSON.stringify({ triggerEvent, createdAt: "2026-11-02T10:00:00.000Z", payload: { uid: "bk1", title: "Démo Northwind", startTime: "2026-11-12T14:00:00Z", organizer: { email: "marie@northwind.fr" }, attendees: [{ email: "Jeanne@Acme.fr" }, { email: "marie@northwind.fr" }], ...payload } });
    const read = (body: string, signature: string) => client("calcom", FIELDS, []).connection.readWebhook!(inbound(body, { "X-Cal-Signature-256": signature }));

    it("accepts a signed booking, naming it as the API does", async () => {
      const body = delivery("BOOKING_CREATED");

      expect(await read(body, hmac(body))).toEqual({
        signals: [{ type: "meeting_booked", channel: "calendar", externalId: "bk1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00.000Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" }],
      });
    });

    it("reads a cancellation, and a reschedule as a booking under its new uid", async () => {
      const cancelled = delivery("BOOKING_CANCELLED");
      const moved = delivery("BOOKING_RESCHEDULED", { uid: "bk2", rescheduleUid: "bk1" });

      expect((await read(cancelled, hmac(cancelled))).signals[0]).toMatchObject({ type: "meeting_cancelled", externalId: "bk1:jeanne@acme.fr:cancelled" });
      expect((await read(moved, hmac(moved))).signals[0]).toMatchObject({ type: "meeting_booked", externalId: "bk2:jeanne@acme.fr" });
    });

    it("has nothing to say about other triggers", async () => {
      const body = delivery("BOOKING_REQUESTED");
      expect(await read(body, hmac(body))).toEqual({ signals: [] });
    });

    it("rejects a forged signature, a tampered body, an absent one and Cal.com's unsigned placeholder", async () => {
      const body = delivery("BOOKING_CREATED");
      await expect(read(body, hmac(body, "someone-elses-secret"))).rejects.toThrow("fausse");
      await expect(read(`${body} `, hmac(body))).rejects.toThrow("fausse");
      await expect(read(body, "")).rejects.toThrow("fausse");
      await expect(read(body, "no-secret-provided")).rejects.toThrow("fausse");
    });

    it("never verifies against an empty secret, which would let anyone sign", async () => {
      const body = delivery("BOOKING_CREATED");
      const connection = adapterOf("calcom")(adapterContext(FIELDS, fakeFetch([]).fetch, { hookUrl: "https://coldlyne.test/api/hooks/x" }));
      await expect(connection.readWebhook!(inbound(body, { "x-cal-signature-256": hmac(body, "") }))).rejects.toThrow("jeton");
    });

    it("refuses a body that isn't JSON even when signed", async () => {
      await expect(read("nonsense", hmac("nonsense"))).rejects.toThrow();
    });
  });
});

describe("Calendly", () => {
  const FIELDS = { token: "pat" };
  const USER_URI = "https://api.calendly.com/users/ME";
  const ME = "GET https://api.calendly.com/users/me";
  const EVENTS = "GET https://api.calendly.com/scheduled_events?";
  const account = { match: ME, json: { resource: { uri: USER_URI, name: "Marie", email: "marie@northwind.fr", current_organization: "https://api.calendly.com/organizations/ORG" } } };
  const EVENT_URI = "https://api.calendly.com/scheduled_events/EV1";
  const event = (overrides: object = {}) => ({ uri: EVENT_URI, name: "Démo Northwind", status: "active", start_time: "2026-11-12T14:00:00.000000Z", updated_at: "2026-11-02T10:00:00.000000Z", invitees_counter: { limit: 1 }, ...overrides });
  const invitee = (overrides: object = {}) => ({ email: "Jeanne@Acme.fr", status: "active", event: EVENT_URI, rescheduled: false, created_at: "2026-11-02T10:00:00.000000Z", updated_at: "2026-11-02T10:00:00.000000Z", ...overrides });
  const collection = (rows: unknown[]) => ({ json: { collection: rows, pagination: { next_page_token: null } } });
  const invitees = (uuid: string, rows: unknown[]) => ({ match: `GET https://api.calendly.com/scheduled_events/${uuid}/invitees`, ...collection(rows) });

  it("checks the token, named after its owner's email", async () => {
    const { connection, calls } = client("calendly", FIELDS, [account]);

    expect(await connection.check()).toEqual({ ok: true, detail: "Compte Marie", label: "marie@northwind.fr" });
    expect(calls[0].url).toBe("https://api.calendly.com/users/me");
    expect(calls[0].headers.get("authorization")).toBe("Bearer pat");
  });

  it("says when Calendly refuses the token", async () => {
    const { connection } = client("calendly", FIELDS, [{ match: ME, status: 401, json: { title: "Unauthenticated", message: "The access token is invalid" } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Calendly a refusé les identifiants : The access token is invalid" });
  });

  it("asks for the owner's events starting since then, and each one's invitees", async () => {
    const { connection, calls } = client("calendly", FIELDS, [account, invitees("EV1", [invitee()]), { match: EVENTS, ...collection([event()]) }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_booked", channel: "calendar", externalId: "EV1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00.000Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
    expect(Object.fromEntries(new URL(calls[1].url).searchParams)).toEqual({ user: USER_URI, min_start_time: "2026-11-01T00:00:00.000Z", count: "100" });
    expect(new URL(calls[2].url).pathname).toBe("/scheduled_events/EV1/invitees");
  });

  it("spends no request on a one-on-one that can't have changed", async () => {
    const { connection, calls } = client("calendly", FIELDS, [account, { match: EVENTS, ...collection([event({ updated_at: "2026-10-01T10:00:00.000000Z" })]) }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("still reads a group event, whose invitees change without touching it, and keeps only who changed", async () => {
    const group = event({ updated_at: "2026-10-01T10:00:00.000000Z", invitees_counter: { limit: 10 } });
    const old = invitee({ email: "ancien@acme.fr", created_at: "2026-10-01T10:00:00.000000Z", updated_at: "2026-10-01T10:00:00.000000Z" });
    const { connection } = client("calendly", FIELDS, [account, invitees("EV1", [old, invitee()]), { match: EVENTS, ...collection([group]) }]);

    expect((await connection.meetingsSince!(SINCE)).map(({ address }) => address)).toEqual(["jeanne@acme.fr"]);
  });

  it("leaves out colleagues, includes cancellations, and treats a reschedule's old side as nothing", async () => {
    const rows = [
      invitee({ email: "marie@northwind.fr" }),
      invitee({ email: "paul@globex.fr", status: "canceled", updated_at: "2026-11-03T10:00:00.000000Z", cancellation: { created_at: "2026-11-03T09:00:00.000000Z" } }),
      invitee({ email: "moved@acme.fr", status: "canceled", rescheduled: true }),
    ];
    const { connection } = client("calendly", FIELDS, [account, invitees("EV1", rows), { match: EVENTS, ...collection([event()]) }]);

    expect(await connection.meetingsSince!(SINCE)).toEqual([
      { type: "meeting_cancelled", channel: "calendar", externalId: "EV1:paul@globex.fr:cancelled", address: "paul@globex.fr", at: new Date("2026-11-03T09:00:00.000Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" },
    ]);
  });

  it("reads every invitee of a cancelled event as cancelled", async () => {
    const { connection } = client("calendly", FIELDS, [account, invitees("EV1", [invitee()]), { match: EVENTS, ...collection([event({ status: "canceled" })]) }]);
    expect((await connection.meetingsSince!(SINCE)).map(({ type }) => type)).toEqual(["meeting_cancelled"]);
  });

  it("follows page tokens", async () => {
    const { connection, calls } = client("calendly", FIELDS, [
      account,
      invitees("EV1", [invitee()]),
      invitees("EV2", [invitee({ event: "https://api.calendly.com/scheduled_events/EV2" })]),
      { match: `${EVENTS}user=${encodeURIComponent(USER_URI)}&min_start_time=2026-11-01T00%3A00%3A00.000Z&count=100&page_token=two`, ...collection([event({ uri: "https://api.calendly.com/scheduled_events/EV2" })]) },
      { match: EVENTS, json: { collection: [event()], pagination: { next_page_token: "two" } } },
    ]);

    expect((await connection.meetingsSince!(SINCE)).map(({ externalId }) => externalId)).toEqual(["EV1:jeanne@acme.fr", "EV2:jeanne@acme.fr"]);
    expect(calls).toHaveLength(5);
  });

  describe("webhooks", () => {
    const NOW_SECONDS = new Date("2026-11-04T09:00:00Z").getTime() / 1000;
    const delivery = (name: string, overrides: object = {}) =>
      JSON.stringify({ event: name, created_at: "2026-11-02T10:00:01.000000Z", payload: { ...invitee(), scheduled_event: { ...event(), event_memberships: [{ user_email: "marie@northwind.fr" }] }, ...overrides } });
    const signed = (body: string, at = NOW_SECONDS, secret = HOOK_SECRET) => `t=${at},v1=${hmac(`${at}.${body}`, secret)}`;
    const read = (body: string, signature: string) => client("calendly", FIELDS, []).connection.readWebhook!(inbound(body, { "Calendly-Webhook-Signature": signature }));

    it("accepts a signed booking, naming it as the API does", async () => {
      const body = delivery("invitee.created");

      expect(await read(body, signed(body))).toEqual({
        signals: [{ type: "meeting_booked", channel: "calendar", externalId: "EV1:jeanne@acme.fr", address: "jeanne@acme.fr", at: new Date("2026-11-02T10:00:00.000Z"), detail: "Démo Northwind, le 12 novembre 2026 à 15:00" }],
      });
    });

    it("reads a cancellation; a reschedule's cancelled side gives nothing", async () => {
      const cancelled = delivery("invitee.canceled", { status: "canceled", updated_at: "2026-11-03T10:00:00.000000Z" });
      const moved = delivery("invitee.canceled", { status: "canceled", rescheduled: true });

      expect((await read(cancelled, signed(cancelled))).signals[0]).toMatchObject({ type: "meeting_cancelled", externalId: "EV1:jeanne@acme.fr:cancelled", at: new Date("2026-11-03T10:00:00.000Z") });
      expect(await read(moved, signed(moved))).toEqual({ signals: [] });
    });

    it("leaves out a colleague, and has nothing to say about other events", async () => {
      const colleague = delivery("invitee.created", { email: "marie@northwind.fr" });
      const other = delivery("routing_form_submission.created");
      expect(await read(colleague, signed(colleague))).toEqual({ signals: [] });
      expect(await read(other, signed(other))).toEqual({ signals: [] });
    });

    it("rejects a forged signature, a tampered body and a missing header", async () => {
      const body = delivery("invitee.created");
      await expect(read(body, signed(body, NOW_SECONDS, "someone-elses-secret"))).rejects.toThrow("fausse");
      await expect(read(`${body} `, signed(body))).rejects.toThrow("fausse");
      await expect(read(body, "")).rejects.toThrow("fausse");
      await expect(read(body, `t=${NOW_SECONDS}`)).rejects.toThrow("fausse");
    });

    it("rejects a valid signature replayed past Calendly's three minutes, and a date that isn't one", async () => {
      const body = delivery("invitee.created");
      await expect(read(body, signed(body, NOW_SECONDS - 181))).rejects.toThrow("trop ancienne");
      expect((await read(body, signed(body, NOW_SECONDS - 179))).signals).toHaveLength(1);
      await expect(read(body, `t=soon,v1=${hmac(`soon.${body}`)}`)).rejects.toThrow("trop ancienne");
    });
  });
});

