import { describe, expect, it } from "vitest";
import { adapterOf } from "@/infrastructure/connectors";
import { adapterContext, fakeFetch, type FakeRoute } from "../support/fetch";
import { expectFrenchTypography } from "../support/french";

function client(kind: Parameters<typeof adapterOf>[0], fields: Record<string, string>, routes: FakeRoute[]) {
  const fake = fakeFetch(routes);
  return { connection: adapterOf(kind)(adapterContext(fields, fake.fetch)), calls: fake.calls };
}

const writes = (calls: { method: string; url: string; body: string }[]) => calls.filter(({ method }) => method !== "GET").map(({ method, url, body }) => ({ method, url, body: JSON.parse(body) }));

describe("Google Postmaster Tools", () => {
  const DOMAINS = "GET https://gmailpostmastertools.googleapis.com/v2/domains";
  const STATS = "POST https://gmailpostmastertools.googleapis.com/v2/domains/northwind.fr/domainStats:query";

  it("counts the verified domains only, on v2", async () => {
    const domains = [{ name: "domains/northwind.fr", verificationState: "VERIFIED" }, { name: "domains/northwind.com", verificationState: "VERIFIED" }, { name: "domains/new.fr", verificationState: "UNVERIFIED" }];
    const { connection, calls } = client("postmaster", {}, [{ match: DOMAINS, json: { domains } }]);

    expect(await connection.check()).toEqual({ ok: true, detail: "2 domaines vérifiés", label: "2 domaines vérifiés" });
    expect(calls[0].url).toBe("https://gmailpostmastertools.googleapis.com/v2/domains?pageSize=200");
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-access-token");
  });

  it("counts across pages, in the singular for one", async () => {
    const { connection } = client("postmaster", {}, [
      { match: `${DOMAINS}?pageSize=200&pageToken=two`, json: { domains: [{ verificationState: "UNVERIFIED" }] } },
      { match: DOMAINS, json: { domains: [{ verificationState: "VERIFIED" }], nextPageToken: "two" } },
    ]);
    expect(await connection.check()).toMatchObject({ ok: true, label: "1 domaine vérifié" });
  });

  it("works with no verified domain yet, and says what to do", async () => {
    const { connection } = client("postmaster", {}, [{ match: DOMAINS, json: {} }]);
    const check = await connection.check();
    expect(check).toMatchObject({ ok: true, label: "0 domaine vérifié" });
    expect(check.detail).toContain("vérifiez votre domaine");
    expectFrenchTypography(check.detail);
  });

  it("says when Google refuses, as it will for a grant made with the old scope", async () => {
    const { connection } = client("postmaster", {}, [{ match: DOMAINS, status: 403, json: { error: { message: "Request had insufficient authentication scopes." } } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Google Postmaster Tools a refusé l’accès : Request had insufficient authentication scopes." });
  });

  it("asks for the daily spam rate over the days wanted, today included", async () => {
    const { connection, calls } = client("postmaster", {}, [{ match: STATS, json: {} }]);

    await connection.reputation!("northwind.fr", 3);

    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual({
      metricDefinitions: [{ name: "spam_rate", baseMetric: { standardMetric: "SPAM_RATE" } }],
      timeQuery: { dateRanges: { dateRanges: [{ start: { year: 2026, month: 11, day: 2 }, end: { year: 2026, month: 11, day: 4 } }] } },
      aggregationGranularity: "DAILY",
      pageSize: 200,
    });
  });

  it("gives each day's spam rate, oldest first, and no reputation since v2 has none", async () => {
    const stat = (day: number, value: object) => ({ name: `domains/northwind.fr/domainStats/${day}`, metric: "spam_rate", date: { year: 2026, month: 11, day }, value });
    const { connection } = client("postmaster", {}, [{ match: STATS, json: { domainStats: [stat(3, { doubleValue: 0.002 }), stat(2, { floatValue: 0.001 }), stat(1, {})] } }]);

    expect(await connection.reputation!("northwind.fr", 7)).toEqual([
      { date: "2026-11-01", reputation: null, spamRate: null },
      { date: "2026-11-02", reputation: null, spamRate: 0.001 },
      { date: "2026-11-03", reputation: null, spamRate: 0.002 },
    ]);
  });

  it("has nothing for a domain too small for Google to report on", async () => {
    const { connection } = client("postmaster", {}, [{ match: STATS, json: {} }]);
    expect(await connection.reputation!("northwind.fr", 7)).toEqual([]);
  });

  it("follows pages, carrying the token in the query's body", async () => {
    const answers = [{ domainStats: [], nextPageToken: "two" }, { domainStats: [{ metric: "spam_rate", date: { year: 2026, month: 11, day: 4 }, value: { doubleValue: 0.01 } }] }];
    const bodies: string[] = [];
    const scripted = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(answers[bodies.length - 1]));
    }) as typeof fetch;

    const connection = adapterOf("postmaster")(adapterContext({}, scripted));

    expect(await connection.reputation!("northwind.fr", 7)).toEqual([{ date: "2026-11-04", reputation: null, spamRate: 0.01 }]);
    expect(JSON.parse(bodies[0]).pageToken).toBeUndefined();
    expect(JSON.parse(bodies[1]).pageToken).toBe("two");
  });
});

describe("Vercel DNS", () => {
  const FIELDS = { token: "vc_token" };
  const USER = "GET https://api.vercel.com/v2/user";
  const DOMAINS = "GET https://api.vercel.com/v5/domains?";
  const RECORDS = "GET https://api.vercel.com/v5/domains/northwind.fr/records";
  const CREATE = "POST https://api.vercel.com/v2/domains/northwind.fr/records";
  const spf = { id: "rec_spf", name: "", type: "TXT", value: "v=spf1 -all" };
  const siteProof = { id: "rec_site", name: "", type: "TXT", value: "google-site-verification=abc" };
  const dmarc = { id: "rec_dmarc", name: "_dmarc", type: "TXT", value: "v=DMARC1; p=none" };
  const key = { id: "rec_dkim", name: "selector1._domainkey", type: "CNAME", value: "selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft" };
  const mx = { id: "rec_mx", name: "", type: "MX", value: "mx1.mail.ovh.net", mxPriority: 1 };
  const website = { id: "rec_a", name: "www", type: "A", value: "76.76.21.21" };

  it("says who the token belongs to and how many domains it reaches, on the team's behalf", async () => {
    const { connection, calls } = client("vercel_dns", { ...FIELDS, teamId: "team_1" }, [
      { match: USER, json: { user: { email: "marie@northwind.fr", username: "marie", name: "Marie" } } },
      { match: `${DOMAINS}limit=100&until=1540095775951`, json: { domains: [{ name: "c.fr" }], pagination: { count: 1, next: null, prev: 1 } } },
      { match: DOMAINS, json: { domains: [{ name: "a.fr" }, { name: "b.fr" }], pagination: { count: 2, next: 1540095775951, prev: null } } },
    ]);

    expect(await connection.check()).toEqual({ ok: true, detail: "3 domaines", label: "marie@northwind.fr" });
    expect(calls[0].headers.get("authorization")).toBe("Bearer vc_token");
    expect(calls[1].url).toBe("https://api.vercel.com/v5/domains?limit=100&teamId=team_1");
  });

  it("says when Vercel refuses the token", async () => {
    const { connection } = client("vercel_dns", FIELDS, [{ match: USER, status: 403, json: { error: { code: "forbidden", message: "Not authorized" } } }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Vercel a refusé l’accès : Not authorized" });
  });

  it("lists the records the port deals in, with names relative to the domain", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [{ match: RECORDS, json: { records: [spf, siteProof, dmarc, key, mx, website] } }]);

    expect(await connection.records!("northwind.fr")).toEqual([
      { type: "TXT", name: "@", value: "v=spf1 -all" },
      { type: "TXT", name: "@", value: "google-site-verification=abc" },
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
      { type: "CNAME", name: "selector1._domainkey", value: "selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft" },
      { type: "MX", name: "@", value: "1 mx1.mail.ovh.net" },
    ]);
    expect(calls[0].url).toBe("https://api.vercel.com/v5/domains/northwind.fr/records?limit=100");
  });

  it("walks the pages of records with until", async () => {
    const { connection, calls } = client("vercel_dns", { ...FIELDS, teamId: "team_1" }, [
      { match: `${RECORDS}?limit=100&until=99`, json: { records: [dmarc], pagination: { count: 1, next: null, prev: 1 } } },
      { match: RECORDS, json: { records: [spf], pagination: { count: 1, next: 99, prev: null } } },
    ]);

    expect(await connection.records!("northwind.fr")).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.vercel.com/v5/domains/northwind.fr/records?limit=100&until=99&teamId=team_1");
  });

  it("updates the record of the same type and name rather than duplicating it", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [
      { match: RECORDS, json: { records: [spf, dmarc] } },
      { match: "PATCH https://api.vercel.com/v1/domains/records/rec_dmarc", json: { id: "rec_dmarc" } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=quarantine" });

    expect(writes(calls)).toEqual([{ method: "PATCH", url: "https://api.vercel.com/v1/domains/records/rec_dmarc", body: { value: "v=DMARC1; p=quarantine" } }]);
  });

  it("replaces the apex's SPF, never the site verification beside it", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [
      { match: RECORDS, json: { records: [siteProof, spf] } },
      { match: "PATCH https://api.vercel.com/v1/domains/records/rec_spf", json: {} },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" });

    expect(writes(calls).map(({ url }) => url)).toEqual(["https://api.vercel.com/v1/domains/records/rec_spf"]);
  });

  it("creates it when there is none, in the zone's own terms", async () => {
    const { connection, calls } = client("vercel_dns", { ...FIELDS, teamId: "team_1" }, [
      { match: RECORDS, json: { records: [siteProof] } },
      { match: CREATE, json: { uid: "rec_new" } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" });

    expect(writes(calls)).toEqual([
      { method: "POST", url: "https://api.vercel.com/v2/domains/northwind.fr/records?teamId=team_1", body: { name: "", type: "TXT", ttl: 3600, value: "v=spf1 include:_spf.google.com ~all" } },
    ]);
  });

  it("writes nothing when the record is already right", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [{ match: RECORDS, json: { records: [dmarc] } }]);
    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" });
    expect(writes(calls)).toEqual([]);
  });

  it("gives an MX's host and priority apart, adding a second one rather than replacing the first", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [
      { match: RECORDS, json: { records: [mx] } },
      { match: CREATE, json: { uid: "rec_new" } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "MX", name: "@", value: "5 mx2.mail.ovh.net" });

    expect(writes(calls)[0].body).toEqual({ name: "", type: "MX", ttl: 3600, value: "mx2.mail.ovh.net", mxPriority: 5 });
  });

  it("finds a sending subdomain's records in its parent's zone", async () => {
    const { connection, calls } = client("vercel_dns", FIELDS, [
      { match: "GET https://api.vercel.com/v5/domains/mail.northwind.fr/records", status: 404, json: { error: { message: "Not found" } } },
      { match: RECORDS, json: { records: [spf, { ...dmarc, id: "rec_sub", name: "_dmarc.mail" }, { ...spf, id: "rec_sub_spf", name: "mail" }] } },
      { match: CREATE, json: { uid: "rec_new" } },
    ]);

    expect(await connection.records!("mail.northwind.fr")).toEqual([
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
      { type: "TXT", name: "@", value: "v=spf1 -all" },
    ]);

    await connection.upsertRecord!("mail.northwind.fr", { type: "TXT", name: "s1._domainkey", value: "v=DKIM1; p=abc" });
    expect(writes(calls)[0]).toEqual({ method: "POST", url: "https://api.vercel.com/v2/domains/northwind.fr/records", body: { name: "s1._domainkey.mail", type: "TXT", ttl: 3600, value: "v=DKIM1; p=abc" } });
  });

  it("says when no zone holds the domain, and doesn't hide other refusals", async () => {
    const missing = client("vercel_dns", FIELDS, [{ match: "GET https://api.vercel.com/v5/domains/", status: 404, json: { error: { message: "Not found" } } }]);
    await expect(missing.connection.records!("unknown.fr")).rejects.toThrow("Vercel ne trouve pas ce qui est demandé");

    const refused = client("vercel_dns", FIELDS, [{ match: "GET https://api.vercel.com/v5/domains/", status: 403, json: { error: { message: "Not authorized" } } }]);
    await expect(refused.connection.records!("mail.northwind.fr")).rejects.toThrow("Not authorized");
    expect(refused.calls).toHaveLength(1);
  });
});

describe("Cloudflare DNS", () => {
  const FIELDS = { apiToken: "cf_token" };
  const API = "https://api.cloudflare.com/client/v4";
  const VERIFY = `GET ${API}/user/tokens/verify`;
  const ZONES = `GET ${API}/zones`;
  const RECORDS = `GET ${API}/zones/zone1/dns_records`;
  const zone = { match: `${ZONES}?name=northwind.fr`, json: { result: [{ id: "zone1", name: "northwind.fr" }] } };
  const spf = { id: "r_spf", name: "northwind.fr", type: "TXT", content: '"v=spf1 -all"' };
  const siteProof = { id: "r_site", name: "northwind.fr", type: "TXT", content: '"google-site-verification=abc"' };
  const dmarc = { id: "r_dmarc", name: "_dmarc.northwind.fr", type: "TXT", content: '"v=DMARC1; " "p=none"' };
  const key = { id: "r_dkim", name: "selector1._domainkey.northwind.fr", type: "CNAME", content: "selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft" };
  const mx = { id: "r_mx", name: "northwind.fr", type: "MX", content: "mx1.mail.ovh.net", priority: 1 };
  const website = { id: "r_a", name: "www.northwind.fr", type: "A", content: "192.0.2.1" };

  it("verifies the token and says which zones it sees", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [
      { match: VERIFY, json: { success: true, result: { id: "t1", status: "active" } } },
      { match: ZONES, json: { result: [{ id: "zone1", name: "northwind.fr", account: { name: "NORTHWIND" } }], result_info: { total_count: 3 } } },
    ]);

    expect(await connection.check()).toEqual({ ok: true, detail: "3 zones", label: "NORTHWIND" });
    expect(calls[0].url).toBe(`${API}/user/tokens/verify`);
    expect(calls[0].headers.get("authorization")).toBe("Bearer cf_token");
    expect(calls[1].url).toBe(`${API}/zones?per_page=5`);
  });

  it("refuses a token Cloudflare no longer accepts", async () => {
    const refused = client("cloudflare_dns", FIELDS, [
      { match: VERIFY, status: 401, json: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } },
      { match: ZONES, status: 401, json: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } },
    ]);
    expect(await refused.connection.check()).toEqual({ ok: false, detail: "Cloudflare a refusé les identifiants : Invalid API Token" });

    const expired = client("cloudflare_dns", FIELDS, [{ match: VERIFY, json: { success: true, result: { id: "t1", status: "expired" } } }]);
    const check = await expired.connection.check();
    expect(check.ok).toBe(false);
    expectFrenchTypography(check.detail);
  });

  it("accepts an account-owned token, which /user/tokens/verify can't vouch for", async () => {
    const { connection } = client("cloudflare_dns", FIELDS, [
      { match: VERIFY, status: 401, json: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } },
      { match: ZONES, json: { result: [{ id: "zone1", name: "northwind.fr" }], result_info: { total_count: 1 } } },
    ]);
    expect(await connection.check()).toEqual({ ok: true, detail: "1 zone", label: "northwind.fr" });
  });

  it("doesn't mistake Cloudflare being down for an account-owned token", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [{ match: VERIFY, status: 500, text: "oops" }]);
    expect(await connection.check()).toEqual({ ok: false, detail: "Cloudflare ne répond pas correctement pour le moment : oops" });
    expect(calls).toHaveLength(1);
  });

  it("says when a valid token sees no zone, instead of failing later on the first change", async () => {
    const { connection } = client("cloudflare_dns", FIELDS, [
      { match: VERIFY, json: { success: true, result: { id: "t1", status: "active" } } },
      { match: ZONES, json: { result: [], result_info: { total_count: 0 } } },
    ]);
    const check = await connection.check();
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("aucune zone");
    expectFrenchTypography(check.detail);
  });

  it("finds the zone by name and lists its records, unquoted and relative to the domain", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [zone, { match: RECORDS, json: { result: [spf, siteProof, dmarc, key, mx, website], result_info: { page: 1, total_pages: 1 } } }]);

    expect(await connection.records!("northwind.fr")).toEqual([
      { type: "TXT", name: "@", value: "v=spf1 -all" },
      { type: "TXT", name: "@", value: "google-site-verification=abc" },
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
      { type: "CNAME", name: "selector1._domainkey", value: "selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft" },
      { type: "MX", name: "@", value: "1 mx1.mail.ovh.net" },
    ]);
    expect(calls[0].url).toBe(`${API}/zones?name=northwind.fr&per_page=5`);
    expect(calls[1].url).toBe(`${API}/zones/zone1/dns_records?per_page=100&page=1`);
  });

  it("walks every page of records", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [
      zone,
      { match: `${RECORDS}?per_page=100&page=2`, json: { result: [dmarc], result_info: { page: 2, total_pages: 2 } } },
      { match: RECORDS, json: { result: [spf], result_info: { page: 1, total_pages: 2 } } },
    ]);

    expect(await connection.records!("northwind.fr")).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it("updates the record of the same type and name rather than duplicating it", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [
      zone,
      { match: RECORDS, json: { result: [spf, dmarc], result_info: { page: 1, total_pages: 1 } } },
      { match: `PATCH ${API}/zones/zone1/dns_records/r_dmarc`, json: { success: true } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=quarantine" });

    expect(writes(calls)).toEqual([{ method: "PATCH", url: `${API}/zones/zone1/dns_records/r_dmarc`, body: { type: "TXT", name: "_dmarc.northwind.fr", ttl: 1, content: '"v=DMARC1; p=quarantine"' } }]);
  });

  it("replaces the apex's SPF, never the site verification beside it", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [
      zone,
      { match: RECORDS, json: { result: [siteProof, spf], result_info: { page: 1, total_pages: 1 } } },
      { match: `PATCH ${API}/zones/zone1/dns_records/r_spf`, json: { success: true } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" });

    expect(writes(calls).map(({ url }) => url)).toEqual([`${API}/zones/zone1/dns_records/r_spf`]);
  });

  it("creates it when there is none: TXT quoted as the API requires, a DKIM CNAME not proxied", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [
      zone,
      { match: RECORDS, json: { result: [siteProof], result_info: { page: 1, total_pages: 1 } } },
      { match: `POST ${API}/zones/zone1/dns_records`, json: { success: true } },
    ]);

    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" });
    await connection.upsertRecord!("northwind.fr", { type: "CNAME", name: "selector1._domainkey", value: "target.example.com" });
    await connection.upsertRecord!("northwind.fr", { type: "MX", name: "@", value: "5 mx2.mail.ovh.net" });

    expect(writes(calls).map(({ body }) => body)).toEqual([
      { type: "TXT", name: "northwind.fr", ttl: 1, content: '"v=spf1 include:_spf.google.com ~all"' },
      { type: "CNAME", name: "selector1._domainkey.northwind.fr", ttl: 1, content: "target.example.com", proxied: false },
      { type: "MX", name: "northwind.fr", ttl: 1, content: "mx2.mail.ovh.net", priority: 5 },
    ]);
  });

  it("writes nothing when the record is already right", async () => {
    const { connection, calls } = client("cloudflare_dns", FIELDS, [zone, { match: RECORDS, json: { result: [spf], result_info: { page: 1, total_pages: 1 } } }]);
    await connection.upsertRecord!("northwind.fr", { type: "TXT", name: "@", value: "v=spf1 -all" });
    expect(writes(calls)).toEqual([]);
  });

  it("finds a sending subdomain's zone at its parent, and keeps only that subdomain's records", async () => {
    const subdomainSpf = { id: "r_sub", name: "mail.northwind.fr", type: "TXT", content: '"v=spf1 -all"' };
    const { connection } = client("cloudflare_dns", FIELDS, [
      { match: `${ZONES}?name=mail.northwind.fr`, json: { result: [] } },
      zone,
      { match: RECORDS, json: { result: [spf, subdomainSpf], result_info: { page: 1, total_pages: 1 } } },
    ]);

    expect(await connection.records!("mail.northwind.fr")).toEqual([{ type: "TXT", name: "@", value: "v=spf1 -all" }]);
  });

  it("says when no zone holds the domain", async () => {
    const { connection } = client("cloudflare_dns", FIELDS, [{ match: ZONES, json: { result: [] } }]);
    const failure = await connection.records!("unknown.fr").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unknown.fr");
    expectFrenchTypography((failure as Error).message);
  });
});
