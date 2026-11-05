import { describe, expect, it } from "vitest";
import { adapterOf } from "@/infrastructure/connectors";
import { ovhDns } from "@/infrastructure/connectors/deliverability/ovh-dns";
import { asciiJson, OVH_API, ovhClient, ovhSignature, readEach } from "@/infrastructure/connectors/ovh";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";

const KEYS = { applicationKey: "app-key", applicationSecret: "app-secret", consumerKey: "consumer-key" };
/** 2026-11-04T09:00:00Z, the test clock, in Unix seconds. */
const NOW = 1793782800;
const TIME: FakeRoute = { match: `GET ${OVH_API}/auth/time`, json: NOW + 12 };

describe("OVHcloud's request signature", () => {
  it("is $1$ and the SHA-1 of the secret, consumer key, method, URL, body and timestamp", () => {
    // Known answer, worked out apart from this code: printf '%s' 'app-secret+consumer-key+GET+https://eu.api.ovh.com/1.0/sms/sms-ab12345-1++1793782800' | shasum -a 1
    expect(ovhSignature(KEYS, "GET", "https://eu.api.ovh.com/1.0/sms/sms-ab12345-1", "", NOW)).toBe("$1$806f70cc3ae7218b6f8d4dff3b4f1bd91433322b");
  });

  it("signs each call on OVH's clock, read once, with the application, consumer and timestamp headers", async () => {
    const { fetch, calls } = fakeFetch([TIME, { match: `GET ${OVH_API}/domain/zone`, json: ["northwind.fr"] }, { match: `POST ${OVH_API}/domain/zone/northwind.fr/refresh`, json: null }]);
    const ovh = ovhClient(adapterContext(KEYS, fetch));

    await ovh.call("GET", "/domain/zone");
    await ovh.call("POST", "/domain/zone/northwind.fr/refresh");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${OVH_API}/auth/time`, `GET ${OVH_API}/domain/zone`, `POST ${OVH_API}/domain/zone/northwind.fr/refresh`]);
    const signed = calls[1].headers;
    expect(signed.get("x-ovh-application")).toBe("app-key");
    expect(signed.get("x-ovh-consumer")).toBe("consumer-key");
    expect(signed.get("x-ovh-timestamp")).toBe(String(NOW + 12));
    expect(signed.get("x-ovh-signature")).toBe(ovhSignature(KEYS, "GET", `${OVH_API}/domain/zone`, "", NOW + 12));
  });

  it("signs the JSON body it sends", async () => {
    const { fetch, calls } = fakeFetch([TIME, { match: `POST ${OVH_API}/domain/zone/northwind.fr/record`, json: { id: 1 } }]);

    await ovhClient(adapterContext(KEYS, fetch)).call("POST", "/domain/zone/northwind.fr/record", { fieldType: "TXT", subDomain: "_dmarc", target: "v=DMARC1; p=none" });

    const body = '{"fieldType":"TXT","subDomain":"_dmarc","target":"v=DMARC1; p=none"}';
    expect(calls[1].body).toBe(body);
    expect(calls[1].headers.get("x-ovh-signature")).toBe(ovhSignature(KEYS, "POST", `${OVH_API}/domain/zone/northwind.fr/record`, body, NOW + 12));
  });

  it("writes bodies in ASCII, so what is signed is what arrives", () => {
    expect(asciiJson({ message: "Êtes-vous l’équipe ?" })).toBe('{"message":"\\u00cates-vous l\\u2019\\u00e9quipe ?"}');
    expect(JSON.parse(asciiJson({ message: "Êtes-vous l’équipe ?" }))).toEqual({ message: "Êtes-vous l’équipe ?" });
  });

  it("reads OVH's clock again after a failure, rather than remembering it", async () => {
    let attempts = 0;
    const flaky = (async (input: RequestInfo | URL) => {
      if (input.toString().endsWith("/auth/time") && ++attempts === 1) return new Response("", { status: 503 });
      return new Response(input.toString().endsWith("/auth/time") ? String(NOW) : "[]");
    }) as typeof fetch;
    const ovh = ovhClient(adapterContext(KEYS, flaky));

    await expect(ovh.call("GET", "/domain/zone")).rejects.toThrow("OVHcloud ne répond pas correctement");
    await expect(ovh.call("GET", "/domain/zone")).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it("reads a long list a few at a time, in order", async () => {
    let running = 0;
    let most = 0;
    const read = async (id: number) => {
      most = Math.max(most, ++running);
      await Promise.resolve();
      running--;
      return id * 2;
    };

    expect(await readEach([1, 2, 3], read)).toEqual([2, 4, 6]);
    expect(await readEach(Array.from({ length: 25 }, (_, index) => index), read)).toHaveLength(25);
    expect(most).toBe(10);
  });
});

/** A zone with an SPF record OVH typed as its own, a verification token, DMARC on a subdomain, a CNAME and an MX. */
function zoneRoutes(extra: FakeRoute[] = []): FakeRoute[] {
  const record = (id: number, fieldType: string, subDomain: string | null, target: string): FakeRoute => ({ match: `GET ${OVH_API}/domain/zone/northwind.fr/record/${id}`, json: { id, zone: "northwind.fr", fieldType, subDomain, target, ttl: 0 } });
  const listing = (fieldType: string, ids: number[]): FakeRoute => ({ match: `GET ${OVH_API}/domain/zone/northwind.fr/record?fieldType=${fieldType}`, json: ids });
  return [
    TIME,
    ...extra,
    listing("TXT", [2, 6]),
    listing("SPF", [1]),
    listing("DKIM", []),
    listing("DMARC", [3]),
    listing("CNAME", [4]),
    listing("MX", [5]),
    record(1, "SPF", null, '"v=spf1 include:mx.ovh.com ~all"'),
    record(2, "TXT", "", '"google-site-verification=abc"'),
    record(3, "DMARC", "_dmarc.mail", '"v=DMARC1; p=none"'),
    record(4, "CNAME", "s1._domainkey.mail", "s1.domainkey.u1.wl.sendgrid.net."),
    record(5, "MX", "", "1 mx1.mail.ovh.net."),
    record(6, "TXT", "s2._domainkey", '"v=DKIM1; k=rsa; p=abc" "def"'),
    { match: `GET ${OVH_API}/domain/zone`, json: ["coldlyne.com", "northwind.fr"] },
    { match: `POST ${OVH_API}/domain/zone/northwind.fr/record`, json: { id: 9 } },
    { match: `PUT ${OVH_API}/domain/zone/northwind.fr/record/`, json: null },
    { match: `POST ${OVH_API}/domain/zone/northwind.fr/refresh`, json: null },
  ];
}

const writesOf = (calls: ReturnType<typeof fakeFetch>["calls"]) => calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.url, call.body]);

describe("OVHcloud DNS", () => {
  it("is found by its kind", () => {
    expect(adapterOf("ovh_dns")).toBe(ovhDns);
  });

  it("checks the keys by listing the account's zones", async () => {
    const { fetch } = fakeFetch([TIME, { match: `GET ${OVH_API}/domain/zone`, json: ["northwind.fr", "coldlyne.com"] }]);

    expect(await ovhDns(adapterContext(KEYS, fetch)).check()).toEqual({ ok: true, label: "northwind.fr, coldlyne.com", detail: "2 zones DNS" });
  });

  it("names the first zones only, and says when there are none", async () => {
    const many = fakeFetch([TIME, { match: `GET ${OVH_API}/domain/zone`, json: ["a.fr", "b.fr", "c.fr", "d.fr"] }]);
    const none = fakeFetch([TIME, { match: `GET ${OVH_API}/domain/zone`, json: [] }]);

    expect(await ovhDns(adapterContext(KEYS, many.fetch)).check()).toEqual({ ok: true, label: "a.fr, b.fr, c.fr…", detail: "4 zones DNS" });
    expect(await ovhDns(adapterContext(KEYS, none.fetch)).check()).toEqual({ ok: false, detail: "Ce compte OVHcloud n’héberge aucune zone DNS." });
  });

  it("says when OVH refuses the keys", async () => {
    const { fetch } = fakeFetch([TIME, { match: `GET ${OVH_API}/domain/zone`, status: 403, json: { message: "This call has not been granted" } }]);
    const check = await ovhDns(adapterContext(KEYS, fetch)).check();

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("OVHcloud a refusé l’accès");
    expect(check.detail).toContain("This call has not been granted");
  });

  it("reads a domain's records under OVH's own types, named relative to the domain, without quotes or final dots", async () => {
    const { fetch } = fakeFetch(zoneRoutes());
    const dns = ovhDns(adapterContext(KEYS, fetch));

    expect(await dns.records!("northwind.fr")).toEqual([
      { type: "TXT", name: "@", value: "google-site-verification=abc" },
      { type: "TXT", name: "s2._domainkey", value: "v=DKIM1; k=rsa; p=abcdef" },
      { type: "TXT", name: "@", value: "v=spf1 include:mx.ovh.com ~all" },
      { type: "TXT", name: "_dmarc.mail", value: "v=DMARC1; p=none" },
      { type: "CNAME", name: "s1._domainkey.mail", value: "s1.domainkey.u1.wl.sendgrid.net" },
      { type: "MX", name: "@", value: "1 mx1.mail.ovh.net" },
    ]);
    expect(await dns.records!("mail.northwind.fr")).toEqual([
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
      { type: "CNAME", name: "s1._domainkey", value: "s1.domainkey.u1.wl.sendgrid.net" },
    ]);
  });

  it("replaces an SPF record OVH typed as its own rather than adding a second, leaves the token alone, then refreshes", async () => {
    const { fetch, calls } = fakeFetch(zoneRoutes());

    await ovhDns(adapterContext(KEYS, fetch)).upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 include:mx.ovh.com include:_spf.google.com ~all" });

    expect(writesOf(calls)).toEqual([
      ["PUT", `${OVH_API}/domain/zone/northwind.fr/record/1`, '{"target":"v=spf1 include:mx.ovh.com include:_spf.google.com ~all"}'],
      ["POST", `${OVH_API}/domain/zone/northwind.fr/refresh`, ""],
    ]);
  });

  it("adds a record at the apex without a subDomain, and keeps a token beside what is already there", async () => {
    const { fetch, calls } = fakeFetch(zoneRoutes());

    await ovhDns(adapterContext(KEYS, fetch)).upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "other-verification=xyz" });

    expect(writesOf(calls)).toEqual([
      ["POST", `${OVH_API}/domain/zone/northwind.fr/record`, '{"fieldType":"TXT","target":"other-verification=xyz"}'],
      ["POST", `${OVH_API}/domain/zone/northwind.fr/refresh`, ""],
    ]);
  });

  it("doesn't duplicate a token already there", async () => {
    const { fetch, calls } = fakeFetch(zoneRoutes());

    await ovhDns(adapterContext(KEYS, fetch)).upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "google-site-verification=abc" });

    expect(writesOf(calls)[0]).toEqual(["PUT", `${OVH_API}/domain/zone/northwind.fr/record/2`, '{"target":"google-site-verification=abc"}']);
  });

  it("adds a record the subdomain doesn't have, in the zone that holds it, with a final dot on a host", async () => {
    const { fetch, calls } = fakeFetch(zoneRoutes([{ match: `GET ${OVH_API}/domain/zone/northwind.fr/record?fieldType=CNAME&subDomain=s2._domainkey.mail`, json: [] }]));

    await ovhDns(adapterContext(KEYS, fetch)).upsertRecord!("mail.northwind.fr", { type: "CNAME", name: "s2._domainkey", value: "s2.domainkey.u1.wl.sendgrid.net" });

    expect(writesOf(calls)).toEqual([
      ["POST", `${OVH_API}/domain/zone/northwind.fr/record`, '{"fieldType":"CNAME","subDomain":"s2._domainkey.mail","target":"s2.domainkey.u1.wl.sendgrid.net."}'],
      ["POST", `${OVH_API}/domain/zone/northwind.fr/refresh`, ""],
    ]);
  });

  it("replaces a CNAME of the same name, even when OVH's loose filter brings back another", async () => {
    const { fetch, calls } = fakeFetch(zoneRoutes([
      { match: `GET ${OVH_API}/domain/zone/northwind.fr/record?fieldType=CNAME&subDomain=s1._domainkey.mail`, json: [7, 4] },
      { match: `GET ${OVH_API}/domain/zone/northwind.fr/record/7`, json: { id: 7, zone: "northwind.fr", fieldType: "CNAME", subDomain: "s1x_domainkey.mail", target: "other.net." } },
    ]));

    await ovhDns(adapterContext(KEYS, fetch)).upsertRecord!("mail.northwind.fr", { type: "CNAME", name: "s1._domainkey", value: "new.domainkey.sendgrid.net." });

    expect(writesOf(calls)[0]).toEqual(["PUT", `${OVH_API}/domain/zone/northwind.fr/record/4`, '{"target":"new.domainkey.sendgrid.net."}']);
  });

  it("says which domain no zone of the account holds", async () => {
    const { fetch } = fakeFetch(zoneRoutes());

    await expect(ovhDns(adapterContext(KEYS, fetch)).records!("northwind.io")).rejects.toThrow("Aucune zone DNS de ce compte OVHcloud ne contient northwind.io.");
  });
});
