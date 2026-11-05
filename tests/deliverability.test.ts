import { describe, expect, it } from "vitest";
import {
  deliverabilityReport,
  dkimSelectorsOf,
  domainAndParents,
  isDomainName,
  parseDmarc,
  parseSpf,
  recordsToFix,
  sameRecord,
  SENDING_DOMAIN_ADVICE,
  spfRecordsIn,
  type DnsAnswers,
  type MailboxProvider,
} from "@/domain/deliverability";
import { checkSendingDomain, lookUpDomain, type DnsResolver } from "@/infrastructure/dns/checks";
import { expectFrenchTypography } from "./support/french";

const GOOGLE_SPF = "v=spf1 include:_spf.google.com ~all";
const DMARC_NONE = "v=DMARC1; p=none; rua=mailto:rapports@northwind.fr";
const GOOGLE_KEY = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

/** A well set up Google domain: each test breaks the part it is about. */
const answers = (overrides: Partial<DnsAnswers> = {}): DnsAnswers => ({
  apexTxt: ["google-site-verification=abc", GOOGLE_SPF],
  spfTree: new Map([["_spf.google.com", "v=spf1 include:_netblocks.google.com ~all"], ["_netblocks.google.com", "v=spf1 ip4:35.190.247.0/24 ~all"]]),
  dmarcTxt: [DMARC_NONE],
  dkim: [{ selector: "google", txt: [GOOGLE_KEY], cname: [] }],
  mx: [{ exchange: "smtp.google.com", priority: 1 }],
  ...overrides,
});

const report = (overrides: Partial<DnsAnswers> = {}, provider: MailboxProvider = "google") => deliverabilityReport(answers(overrides), provider);

describe("a domain a member typed", () => {
  it.each(["acme.fr", "mail.acme.fr", " Acme.FR. ", "a-b.co.uk"])("takes %s", (name) => {
    expect(isDomainName(name)).toBe(true);
  });

  it.each(["", "acme", "https://acme.fr", "ada@acme.fr", "acme.fr/contact", "-acme.fr", "acme..fr", "127.0.0.1"])("refuses %s", (name) => {
    expect(isDomainName(name)).toBe(false);
  });
});

describe("reading SPF", () => {
  it("tells SPF records from the rest of the TXT at the apex", () => {
    expect(spfRecordsIn(["google-site-verification=abc", " v=spf1 -all ", "v=spf10 nope", "V=SPF1 ~all"])).toEqual(["v=spf1 -all", "V=SPF1 ~all"]);
  });

  it("counts what costs a DNS lookup, and only that", () => {
    expect(parseSpf("v=spf1 ip4:192.0.2.1 ip6:2001:db8::1 a mx:mail.northwind.fr ptr exists:%{i}.northwind.fr include:_spf.google.com ~all")).toEqual({ lookups: 5, includes: ["_spf.google.com"], redirect: null, all: "~all" });
    expect(parseSpf("v=spf1 redirect=_spf.northwind.fr exp=why.northwind.fr")).toEqual({ lookups: 1, includes: [], redirect: "_spf.northwind.fr", all: null });
    expect(parseSpf("v=spf1 +a/24 -mx -all").lookups).toBe(2);
  });
});

describe("the SPF report", () => {
  it("is fine with one record authorizing the provider", () => {
    expect(report().spf).toEqual({ ok: true, found: [GOOGLE_SPF], advice: [] });
  });

  it("says when there is none, and how to add it", () => {
    const { spf } = report({ apexTxt: ["google-site-verification=abc"], spfTree: new Map() });
    expect(spf.ok).toBe(false);
    expect(spf.found).toEqual([]);
    expect(spf.advice[0]).toContain(GOOGLE_SPF);
  });

  it("refuses two records: receivers reject both", () => {
    const { spf } = report({ apexTxt: [GOOGLE_SPF, "v=spf1 include:mx.ovh.com ~all"] });
    expect(spf.ok).toBe(false);
    expect(spf.found).toHaveLength(2);
    expect(spf.advice[0]).toContain("Fusionnez");
  });

  it("says when the provider isn't authorized", () => {
    const { spf } = report({ apexTxt: ["v=spf1 include:mx.ovh.com ~all"], spfTree: new Map([["mx.ovh.com", "v=spf1 ip4:192.0.2.0/24 ~all"]]) });
    expect(spf.ok).toBe(false);
    expect(spf.advice[0]).toContain("include:_spf.google.com");
  });

  it("accepts the provider authorized through another include", () => {
    const { spf } = report({ apexTxt: ["v=spf1 include:spf.northwind.fr ~all"], spfTree: new Map([["spf.northwind.fr", GOOGLE_SPF], ["_spf.google.com", "v=spf1 ip4:192.0.2.0/24 ~all"]]) });
    expect(spf.ok).toBe(true);
  });

  it("catches an SPF past 10 lookups, nested includes counted", () => {
    const nested = Array.from({ length: 11 }, (_, index) => `include:n${index}.mail.fr`).join(" ");
    const { spf } = report({ apexTxt: [`v=spf1 include:_spf.google.com include:vendor.fr ~all`], spfTree: new Map([["_spf.google.com", "v=spf1 ~all"], ["vendor.fr", `v=spf1 ${nested} ~all`]]) });
    expect(spf.ok).toBe(false);
    expect(spf.advice.join(" ")).toContain("plus de 10 recherches DNS");
  });

  it("allows exactly 10", () => {
    const includes = Array.from({ length: 9 }, (_, index) => `include:n${index}.mail.fr`).join(" ");
    const { spf } = report({ apexTxt: [`v=spf1 include:_spf.google.com ${includes} ~all`], spfTree: new Map() });
    expect(spf.ok).toBe(true);
  });

  it("survives includes that loop, or that are named like an object's own properties", () => {
    const { spf } = report({ apexTxt: ["v=spf1 include:_spf.google.com include:a.fr include:constructor ~all"], spfTree: new Map([["_spf.google.com", "v=spf1 ~all"], ["a.fr", "v=spf1 include:b.fr ~all"], ["b.fr", "v=spf1 include:a.fr ~all"]]) });
    expect(spf.ok).toBe(true);
  });

  it("says when an include publishes no SPF", () => {
    const { spf } = report({ apexTxt: ["v=spf1 include:_spf.google.com include:gone.fr ~all"], spfTree: new Map([["_spf.google.com", "v=spf1 ~all"], ["gone.fr", null]]) });
    expect(spf.ok).toBe(false);
    expect(spf.advice.join(" ")).toContain("include:gone.fr");
  });

  it("refuses +all, warns about ?all, and asks for a closing term", () => {
    const tree = { spfTree: new Map([["_spf.google.com", "v=spf1 ~all"]]) };
    const open = report({ apexTxt: ["v=spf1 include:_spf.google.com +all"], ...tree }).spf;
    expect(open.ok).toBe(false);
    expect(open.advice[0]).toContain("~all");

    const neutral = report({ apexTxt: ["v=spf1 include:_spf.google.com ?all"], ...tree }).spf;
    expect(neutral.ok).toBe(true);
    expect(neutral.advice[0]).toContain("?all");

    const unclosed = report({ apexTxt: ["v=spf1 include:_spf.google.com"], ...tree }).spf;
    expect(unclosed.ok).toBe(false);

    expect(report({ apexTxt: ["v=spf1 include:_spf.google.com redirect=spf.northwind.fr"], ...tree }).spf.ok).toBe(true);
  });

  it.each([
    ["microsoft", "spf.protection.outlook.com"],
    ["ovh", "mx.ovh.com"],
    ["infomaniak", "spf.infomaniak.ch"],
  ] as const)("knows %s's include", (provider, include) => {
    expect(report({ apexTxt: [`v=spf1 include:${include} -all`], spfTree: new Map([[include, "v=spf1 -all"]]) }, provider).spf.ok).toBe(true);
    expect(report({ apexTxt: [GOOGLE_SPF] }, provider).spf.advice[0]).toContain(`include:${include}`);
  });
});

describe("reading DMARC", () => {
  it("reads the policy, the report addresses and the percentage", () => {
    expect(parseDmarc("v=DMARC1; p=Quarantine; pct=25; rua=mailto:a@northwind.fr, mailto:b@northwind.fr; adkim=s")).toEqual({ policy: "quarantine", rua: ["mailto:a@northwind.fr", "mailto:b@northwind.fr"], pct: 25 });
  });

  it("defaults the percentage to 100, and has no policy when none is written", () => {
    expect(parseDmarc("v=DMARC1;rua=mailto:a@northwind.fr")).toEqual({ policy: null, rua: ["mailto:a@northwind.fr"], pct: 100 });
    expect(parseDmarc("v=DMARC1; p=none; pct=lots").pct).toBe(100);
  });
});

describe("the DMARC report", () => {
  it("accepts p=none as a start, and says what comes next", () => {
    const { dmarc } = report();
    expect(dmarc.ok).toBe(true);
    expect(dmarc.found).toEqual([DMARC_NONE]);
    expect(dmarc.advice).toHaveLength(1);
    expect(dmarc.advice[0]).toContain("p=quarantine");
  });

  it("has nothing more to say about a full policy with reports", () => {
    expect(report({ dmarcTxt: ["v=DMARC1; p=quarantine; rua=mailto:r@northwind.fr"] }).dmarc).toEqual({ ok: true, found: ["v=DMARC1; p=quarantine; rua=mailto:r@northwind.fr"], advice: [] });
    expect(report({ dmarcTxt: ["v=DMARC1; p=reject; rua=mailto:r@northwind.fr"] }).dmarc.advice).toEqual([]);
  });

  it("says when a policy covers only part of the mail, or no report will come", () => {
    const partial = report({ dmarcTxt: ["v=DMARC1; p=quarantine; pct=25; rua=mailto:r@northwind.fr"] }).dmarc;
    expect(partial.ok).toBe(true);
    expect(partial.advice[0]).toContain("25");

    const silent = report({ dmarcTxt: ["v=DMARC1; p=none"] }).dmarc;
    expect(silent.ok).toBe(true);
    expect(silent.advice.join(" ")).toContain("rua");
  });

  it("says when there is none, when there are two, and when the policy is meaningless", () => {
    const none = report({ dmarcTxt: [] }).dmarc;
    expect(none.ok).toBe(false);
    expect(none.advice[0]).toContain("v=DMARC1; p=none");

    expect(report({ dmarcTxt: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }).dmarc.ok).toBe(false);
    expect(report({ dmarcTxt: ["v=DMARC1; p=sometimes"] }).dmarc.ok).toBe(false);
    expect(report({ dmarcTxt: ["v=DMARC1; rua=mailto:r@northwind.fr"] }).dmarc.ok).toBe(false);
  });
});

describe("the DKIM report", () => {
  it("finds Google's key at its selector", () => {
    expect(report().dkim).toEqual({ ok: true, found: [`google._domainkey → ${GOOGLE_KEY}`], advice: [] });
  });

  it("says where Google's key comes from when it's missing or revoked, rather than inventing one", () => {
    const missing = report({ dkim: [{ selector: "google", txt: [], cname: [] }] }).dkim;
    expect(missing.ok).toBe(false);
    expect(missing.advice[0]).toContain("console d’administration");

    expect(report({ dkim: [{ selector: "google", txt: ["v=DKIM1; p="], cname: [] }] }).dkim.ok).toBe(false);
  });

  it("wants both of Microsoft's CNAMEs", () => {
    const one = { selector: "selector1", txt: [], cname: ["selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft"] };
    const both = report({ dkim: [one, { ...one, selector: "selector2" }] }, "microsoft").dkim;
    expect(both.ok).toBe(true);
    expect(both.found[0]).toBe("selector1._domainkey → selector1-northwind-fr._domainkey.northwind.n-v1.dkim.mail.microsoft");

    const half = report({ dkim: [one, { selector: "selector2", txt: [], cname: [] }] }, "microsoft").dkim;
    expect(half.ok).toBe(false);
    expect(half.advice[0]).toContain("selector2._domainkey");
    expect(half.advice[0]).toContain("Microsoft Defender");
  });

  it.each(["ovh", "infomaniak"] as const)("can't vouch for %s without the member's selector, and doesn't call it missing", (provider) => {
    const { dkim } = report({ dkim: [] }, provider);
    expect(dkim.ok).toBe(false);
    expect(dkim.advice[0]).toContain("ne veut pas dire qu’il manque");
  });

  it("checks an OVHcloud selector the member copied", () => {
    const cname = "ovhmo1234567-selector1._domainkey.123403.aj.dkim.mail.ovh.net";
    expect(report({ dkim: [{ selector: "ovhmo1234567-selector1", txt: [], cname: [cname] }] }, "ovh").dkim.ok).toBe(true);
  });

  it("looks up the provider's selectors, or the ones given", () => {
    expect(dkimSelectorsOf("google")).toEqual(["google"]);
    expect(dkimSelectorsOf("microsoft")).toEqual(["selector1", "selector2"]);
    expect(dkimSelectorsOf("ovh")).toEqual([]);
    expect(dkimSelectorsOf("ovh", ["OVHmo123-selector1._domainkey.northwind.fr", " ovhmo123-selector2 "])).toEqual(["ovhmo123-selector1", "ovhmo123-selector2"]);
    expect(dkimSelectorsOf("google", ["custom"])).toEqual(["custom"]);
  });
});

describe("the MX report", () => {
  it("lists what it finds", () => {
    expect(report().mx).toEqual({ ok: true, found: ["1 smtp.google.com"], advice: [] });
  });

  it("says when there is none, and reads a null MX as none", () => {
    expect(report({ mx: [] }).mx.ok).toBe(false);
    expect(report({ mx: [{ exchange: "", priority: 0 }] }).mx.ok).toBe(false);
    expect(report({ mx: [] }).mx.advice[0]).toContain("Google Workspace");
  });
});

describe("what can be fixed", () => {
  it("is nothing on a domain that is set up", () => {
    expect(recordsToFix(answers(), "google")).toEqual([]);
  });

  it("adds SPF and a monitoring DMARC to a bare domain, for the chosen provider", () => {
    const bare = answers({ apexTxt: [], spfTree: new Map(), dmarcTxt: [], dkim: [], mx: [] });
    expect(recordsToFix(bare, "google")).toEqual([
      { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" },
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" },
    ]);
    expect(recordsToFix(bare, "microsoft")[0].value).toBe("v=spf1 include:spf.protection.outlook.com -all");
    expect(recordsToFix(bare, "ovh")[0].value).toBe("v=spf1 include:mx.ovh.com ~all");
    expect(recordsToFix(bare, "infomaniak")[0].value).toBe("v=spf1 include:spf.infomaniak.ch -all");
  });

  it("sends DMARC's reports where the member says, never to an invented mailbox", () => {
    expect(recordsToFix(answers({ dmarcTxt: [] }), "google", { dmarcReports: "rapports@northwind.fr" })).toEqual([{ type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none; rua=mailto:rapports@northwind.fr" }]);
  });

  it("corrects an SPF in place, keeping what it already authorizes", () => {
    const fixes = recordsToFix(answers({ apexTxt: ["v=spf1 ip4:192.0.2.1 include:mx.ovh.com ~all"], spfTree: new Map([["mx.ovh.com", "v=spf1 ~all"]]) }), "google");
    expect(fixes).toEqual([{ type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ip4:192.0.2.1 include:mx.ovh.com ~all" }]);
  });

  it("closes an open or unfinished SPF", () => {
    const tree = { spfTree: new Map([["_spf.google.com", "v=spf1 ~all"]]) };
    expect(recordsToFix(answers({ apexTxt: ["v=spf1 include:_spf.google.com +all"], ...tree }), "google")[0].value).toBe("v=spf1 include:_spf.google.com ~all");
    expect(recordsToFix(answers({ apexTxt: ["v=spf1 include:_spf.google.com"], ...tree }), "google")[0].value).toBe("v=spf1 include:_spf.google.com ~all");
  });

  it("leaves duplicates and an overweight SPF to the member: both take choices", () => {
    expect(recordsToFix(answers({ apexTxt: [GOOGLE_SPF, "v=spf1 -all"] }), "google")).toEqual([]);
    const includes = Array.from({ length: 11 }, (_, index) => `include:n${index}.mail.fr`).join(" ");
    expect(recordsToFix(answers({ apexTxt: [`v=spf1 ${includes} ~all`], spfTree: new Map() }), "google")).toEqual([]);
  });

  it("gives a DMARC without a valid policy a p=none, and never lowers one that works", () => {
    expect(recordsToFix(answers({ dmarcTxt: ["v=DMARC1; p=sometimes"] }), "google")).toEqual([{ type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" }]);
    expect(recordsToFix(answers({ dmarcTxt: ["v=DMARC1; p=reject"] }), "google")).toEqual([]);
    expect(recordsToFix(answers({ dmarcTxt: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }), "google")).toEqual([]);
  });

  it("never proposes a DKIM key or an MX: they can't be known from here", () => {
    const bare = answers({ dkim: [{ selector: "google", txt: [], cname: [] }], mx: [] });
    expect(recordsToFix(bare, "google").map(({ type, name }) => [type, name])).toEqual([]);
  });
});

describe("telling records apart", () => {
  const txt = (name: string, value: string) => ({ type: "TXT" as const, name, value });

  it("takes a CNAME of the same name for the same record, whatever it points to", () => {
    expect(sameRecord({ type: "CNAME", name: "s1._domainkey", value: "a.example.com" }, { type: "CNAME", name: "S1._domainkey.", value: "b.example.com" })).toBe(true);
  });

  it("keeps an apex's TXT apart by what they are for", () => {
    expect(sameRecord(txt("@", "v=spf1 -all"), txt("@", GOOGLE_SPF))).toBe(true);
    expect(sameRecord(txt("@", "google-site-verification=abc"), txt("@", GOOGLE_SPF))).toBe(false);
    expect(sameRecord(txt("@", "google-site-verification=abc"), txt("@", "google-site-verification=abc"))).toBe(true);
    expect(sameRecord(txt("_dmarc", "v=DMARC1; p=none"), txt("@", "v=DMARC1; p=none"))).toBe(false);
  });

  it("keeps a domain's MX apart by host, so changing one priority doesn't drop the others", () => {
    const mx = (value: string) => ({ type: "MX" as const, name: "@", value });
    expect(sameRecord(mx("1 mx1.mail.ovh.net"), mx("5 MX1.mail.ovh.net."))).toBe(true);
    expect(sameRecord(mx("1 mx1.mail.ovh.net"), mx("5 mx2.mail.ovh.net"))).toBe(false);
    expect(sameRecord(txt("@", "x"), { type: "CNAME", name: "@", value: "x" })).toBe(false);
  });

  it("walks a domain up to its registrable parent", () => {
    expect(domainAndParents("Mail.Northwind.fr.")).toEqual(["mail.northwind.fr", "northwind.fr"]);
    expect(domainAndParents("northwind.fr")).toEqual(["northwind.fr"]);
    expect(domainAndParents("localhost")).toEqual(["localhost"]);
  });
});

describe("the report's words", () => {
  it("keep French typography, whatever goes wrong", () => {
    const bad = [
      report({ apexTxt: [], spfTree: new Map(), dmarcTxt: [], dkim: [], mx: [] }),
      report({ apexTxt: [], spfTree: new Map(), dmarcTxt: [], dkim: [], mx: [] }, "microsoft"),
      report({ apexTxt: [], spfTree: new Map(), dmarcTxt: [], dkim: [], mx: [] }, "ovh"),
      report({ apexTxt: [], spfTree: new Map(), dmarcTxt: [], dkim: [], mx: [] }, "infomaniak"),
      report({ apexTxt: [GOOGLE_SPF, "v=spf1 -all"], dmarcTxt: ["v=DMARC1; p=none", "v=DMARC1; p=none"], dkim: [{ selector: "google", txt: [], cname: [] }] }),
      report({ apexTxt: ["v=spf1 include:gone.fr +all"], spfTree: new Map([["gone.fr", null]]), dmarcTxt: ["v=DMARC1; p=quarantine; pct=10"] }),
      report({ apexTxt: ["v=spf1 ?all"], spfTree: new Map(), dmarcTxt: ["v=DMARC1; p=sometimes"] }),
      report({ apexTxt: ["v=spf1 include:_spf.google.com"], spfTree: new Map(), dmarcTxt: ["v=DMARC1; p=none"] }),
      report({ apexTxt: [`v=spf1 ${Array.from({ length: 11 }, (_, index) => `include:n${index}.fr`).join(" ")} ~all`], spfTree: new Map() }),
    ];
    const advice = bad.flatMap(({ spf, dkim, dmarc, mx }) => [...spf.advice, ...dkim.advice, ...dmarc.advice, ...mx.advice]);

    expect(advice.length).toBeGreaterThan(15);
    advice.forEach(expectFrenchTypography);
    expectFrenchTypography(SENDING_DOMAIN_ADVICE);
  });
});

describe("looking a domain up", () => {
  type Tables = { txt?: Record<string, string[][]>; mx?: Record<string, { exchange: string; priority: number }[]>; cname?: Record<string, string[]> };

  /** A resolver over fixed tables; an unknown name fails as DNS does, and the names asked are kept. */
  function fakeResolver({ txt = {}, mx = {}, cname = {} }: Tables) {
    const asked: string[] = [];
    const answer = <T>(table: Record<string, T[]>) => async (name: string) => {
      asked.push(name);
      if (table[name]) return table[name];
      throw Object.assign(new Error(`queryAny ENODATA ${name}`), { code: "ENODATA" });
    };
    const resolver: DnsResolver = { resolveTxt: answer(txt), resolveMx: answer(mx), resolveCname: answer(cname) };
    return { resolver, asked };
  }

  const northwind: Tables = {
    txt: {
      "northwind.fr": [["google-site-verification=abc"], ["v=spf1 include:_spf.", "google.com ~all"]],
      "_spf.google.com": [["v=spf1 include:_netblocks.google.com ~all"]],
      "_netblocks.google.com": [["v=spf1 ip4:35.190.247.0/24 ~all"]],
      "_dmarc.northwind.fr": [[DMARC_NONE]],
      "google._domainkey.northwind.fr": [["v=DKIM1; k=rsa; ", "p=MIIBIjANBgkq"]],
    },
    mx: { "northwind.fr": [{ exchange: "smtp.google.com", priority: 1 }] },
  };

  it("gathers the answers, joining TXT chunks and following includes", async () => {
    const { resolver } = fakeResolver(northwind);

    expect(await lookUpDomain("Northwind.fr", "google", { resolver })).toEqual({
      apexTxt: ["google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"],
      spfTree: new Map([["_spf.google.com", "v=spf1 include:_netblocks.google.com ~all"], ["_netblocks.google.com", "v=spf1 ip4:35.190.247.0/24 ~all"]]),
      dmarcTxt: [DMARC_NONE],
      dkim: [{ selector: "google", txt: ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"], cname: [] }],
      mx: [{ exchange: "smtp.google.com", priority: 1 }],
    });
  });

  it("reports on a healthy domain, with nothing to fix and the standing advice", async () => {
    const { resolver } = fakeResolver(northwind);

    const check = await checkSendingDomain("northwind.fr", "google", { resolver });

    expect(check.report.spf.ok).toBe(true);
    expect(check.report.dkim.ok).toBe(true);
    expect(check.report.dmarc.ok).toBe(true);
    expect(check.report.mx.ok).toBe(true);
    expect(check.fixes).toEqual([]);
    expect(check.recommendation).toBe(SENDING_DOMAIN_ADVICE);
  });

  it("reports on a bare domain, and proposes what can be published", async () => {
    const { resolver } = fakeResolver({});

    const check = await checkSendingDomain("northwind.fr", "microsoft", { resolver, dmarcReports: "rapports@northwind.fr" });

    expect([check.report.spf.ok, check.report.dkim.ok, check.report.dmarc.ok, check.report.mx.ok]).toEqual([false, false, false, false]);
    expect(check.fixes).toEqual([
      { type: "TXT", name: "@", value: "v=spf1 include:spf.protection.outlook.com -all" },
      { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none; rua=mailto:rapports@northwind.fr" },
    ]);
  });

  it("asks the provider's selectors, and the member's where each service has its own", async () => {
    const microsoft = fakeResolver({ cname: { "selector1._domainkey.northwind.fr": ["a.dkim.mail.microsoft"], "selector2._domainkey.northwind.fr": ["b.dkim.mail.microsoft"] } });
    expect((await lookUpDomain("northwind.fr", "microsoft", { resolver: microsoft.resolver })).dkim).toEqual([
      { selector: "selector1", txt: [], cname: ["a.dkim.mail.microsoft"] },
      { selector: "selector2", txt: [], cname: ["b.dkim.mail.microsoft"] },
    ]);

    const ovh = fakeResolver({});
    expect((await lookUpDomain("northwind.fr", "ovh", { resolver: ovh.resolver })).dkim).toEqual([]);
    expect(ovh.asked.some((name) => name.includes("_domainkey"))).toBe(false);

    const given = fakeResolver({ cname: { "ovhmo1-selector1._domainkey.northwind.fr": ["k.dkim.mail.ovh.net"] } });
    expect((await lookUpDomain("northwind.fr", "ovh", { resolver: given.resolver, dkimSelectors: ["ovhmo1-selector1"] })).dkim[0].cname).toEqual(["k.dkim.mail.ovh.net"]);
  });

  it("takes a subdomain's DMARC from its parent when it has none", async () => {
    const { resolver, asked } = fakeResolver({ txt: { "_dmarc.northwind.fr": [["v=DMARC1; p=quarantine"]] } });

    expect((await lookUpDomain("mail.northwind.fr", "google", { resolver })).dmarcTxt).toEqual(["v=DMARC1; p=quarantine"]);
    expect(asked).toContain("_dmarc.mail.northwind.fr");
  });

  it("marks an include without SPF, and stops on loops and absurd trees", async () => {
    const broken = fakeResolver({ txt: { "northwind.fr": [["v=spf1 include:gone.fr ~all"]] } });
    expect((await lookUpDomain("northwind.fr", "google", { resolver: broken.resolver })).spfTree.get("gone.fr")).toBeNull();

    const looping = fakeResolver({ txt: { "northwind.fr": [["v=spf1 include:a.fr ~all"]], "a.fr": [["v=spf1 include:b.fr ~all"]], "b.fr": [["v=spf1 include:a.fr ~all"]] } });
    expect((await lookUpDomain("northwind.fr", "google", { resolver: looping.resolver })).spfTree.size).toBe(2);

    let served = 0;
    const endless: DnsResolver = {
      resolveTxt: async (name) => (name.startsWith("_") || name.includes("_domainkey") ? [] : [[`v=spf1 include:n${++served}.fr ~all`]]),
      resolveMx: async () => [],
      resolveCname: async () => [],
    };
    expect((await lookUpDomain("northwind.fr", "google", { resolver: endless })).spfTree.size).toBeLessThanOrEqual(40);
  });

  it("doesn't take a DNS failure for a missing record", async () => {
    const timeout = Object.assign(new Error("queryTxt ETIMEOUT northwind.fr"), { code: "ETIMEOUT" });
    const resolver: DnsResolver = {
      resolveTxt: async () => {
        throw timeout;
      },
      resolveMx: async () => [],
      resolveCname: async () => [],
    };
    await expect(checkSendingDomain("northwind.fr", "google", { resolver })).rejects.toBe(timeout);
  });

  it("reads a domain that doesn't exist as having nothing", async () => {
    const notFound = Object.assign(new Error("queryTxt ENOTFOUND nope.fr"), { code: "ENOTFOUND" });
    const fail = async () => {
      throw notFound;
    };
    const check = await checkSendingDomain("nope.fr", "google", { resolver: { resolveTxt: fail, resolveMx: fail, resolveCname: fail } });
    expect(check.report.mx.ok).toBe(false);
  });
});
