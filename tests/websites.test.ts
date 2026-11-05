import { describe, expect, it, vi } from "vitest";
import { contactsIn, httpsUrl, socialProfile } from "@/domain/contacts";
import { readCompanyWebsite } from "@/infrastructure/websites/reader";
import { EVERYTHING_ALLOWED, parseRobots, robotsAllows } from "@/infrastructure/websites/robots";
import { fakeFetch, type FakeRoute } from "./support/fetch";

const SITE = "https://acme.fr";

/** A site: robots.txt that says nothing unless told otherwise, and these pages, by path. */
function site(pages: Record<string, string>, robots: FakeRoute = { match: `GET ${SITE}/robots.txt`, status: 404 }) {
  const routes: FakeRoute[] = [robots, ...Object.entries(pages).map(([path, text]) => ({ match: `GET ${SITE}${path}`, text, headers: { "content-type": "text/html; charset=utf-8" } }))];
  // Longest paths first: a route matches a URL by prefix.
  routes.sort((a, b) => b.match.length - a.match.length);
  return fakeFetch(routes);
}

const asked = (calls: { url: string }[]) => calls.map(({ url }) => url.replace(SITE, ""));

describe("finding emails on a page", () => {
  const emails = (body: string) => contactsIn(`<html><body>${body}</body></html>`, `${SITE}/`).filter(({ kind }) => kind === "email").map(({ value }) => value);

  it("reads mailto links, whatever they carry", () => {
    expect(emails('<a href="mailto:Contact%40Acme.FR?subject=Bonjour&amp;cc=x">Écrire</a>')).toEqual(["contact@acme.fr"]);
    expect(emails('<a href="mailto:a@acme.fr,b@acme.fr">Écrire</a>')).toEqual(["a@acme.fr", "b@acme.fr"]);
  });

  it("reads addresses in the text, encoded or not", () => {
    expect(emails("<p>Écrivez à jeanne@acme.fr.</p><p>contact&#64;acme.fr</p>")).toEqual(["jeanne@acme.fr", "contact@acme.fr"]);
  });

  it.each([
    ["contact [at] acme.fr"],
    ["contact(at)acme.fr"],
    ["contact (arobase) acme.fr"],
    ["contact [arobase] acme.fr"],
    ["contact arobase acme.fr"],
    ["contact [at] acme [dot] fr"],
    ["contact (at) acme (point) fr"],
    ["contact arobase acme point fr"],
    ["contact @ acme.fr"],
    ["CONTACT[AT]ACME.FR"],
  ])("finds the address hidden in %s", (hidden) => {
    expect(emails(`<p>${hidden}</p>`)).toEqual(["contact@acme.fr"]);
  });

  it("doesn't take the French word point for a dot after a whole address", () => {
    expect(emails("<p>contact@acme.fr point de vente</p>")).toEqual(["contact@acme.fr"]);
  });

  it("doesn't glue adjacent elements together", () => {
    expect(emails("<span>contact@acme.fr</span><span>Tél</span>")).toEqual(["contact@acme.fr"]);
  });

  it.each([
    ["an image named like an address", "<p>logo@2x.png icone@3x.webp photo@2x.jpeg</p>"],
    ["a script", '<script>var email = "dev@acme.fr"</script>'],
    ["a style", "<style>/* design@acme.fr */</style>"],
    ["a comment", "<!-- ancien@acme.fr -->"],
    ["a form's placeholder", "<p>votre.email@domaine.fr ou prenom.nom@entreprise.fr ou vous@example.com</p>"],
    ["an error reporter's snippet", "<p>abc123@sentry.io et def456@sentry-next.wixpress.com</p>"],
    ["an address nobody reads", '<a href="mailto:no-reply@acme.fr">x</a> <p>ne-pas-repondre@acme.fr</p>'],
    ["a link that isn't a mailto", '<a href="https://x.fr/?email=a@acme.fr">x</a>'],
  ])("leaves out %s", (_, body) => {
    expect(emails(body)).toEqual([]);
  });
});

describe("finding phone numbers on a page", () => {
  const phones = (body: string) => contactsIn(`<html><body>${body}</body></html>`, `${SITE}/`).filter(({ kind }) => kind === "phone").map(({ value }) => value);

  it("reads them in every usual writing, as E.164", () => {
    expect(phones('<a href="tel:+33123456789">Appeler</a>')).toEqual(["+33123456789"]);
    expect(phones("<p>01 23 45 67 89</p>")).toEqual(["+33123456789"]);
    expect(phones("<p>Tél.&nbsp;: 04.72.00.00.00 ou +33 (0)6 12 34 56 78 ou (+33) 7 12 34 56 78</p>")).toEqual(["+33472000000", "+33612345678", "+33712345678"]);
    expect(phones("<p>La Réunion : +262 692 12 34 56, ou 0692 12 34 57</p>")).toEqual(["+262692123456", "+262692123457"]);
  });

  it("leaves out company numbers and foreign phones", () => {
    expect(phones("<p>SIRET 732 829 320 00012, RCS 732829320, n° 01234567890123</p>")).toEqual([]);
    expect(phones('<a href="tel:+442079460958">Londres</a>')).toEqual([]);
  });

  it("leaves out a fax", () => {
    expect(phones("<p>Tél : 01 23 45 67 89 — Fax : 01 23 45 67 90 — Télécopie 01 23 45 67 91</p>")).toEqual(["+33123456789"]);
  });
});

describe("finding profiles on a page", () => {
  it.each([
    ["https://www.linkedin.com/company/acme-holding/", "linkedin", "https://www.linkedin.com/company/acme-holding"],
    ["https://fr.linkedin.com/in/jeanne-dupont?utm_source=site", "linkedin", "https://www.linkedin.com/in/jeanne-dupont"],
    ["https://www.linkedin.com/company/acme/about/", "linkedin", "https://www.linkedin.com/company/acme"],
    ["https://www.instagram.com/acme.fr/?hl=fr", "instagram", "https://www.instagram.com/acme.fr"],
    ["https://instagram.com/ACME", "instagram", "https://www.instagram.com/acme"],
    ["https://www.facebook.com/AcmeHolding/", "facebook", "https://www.facebook.com/acmeholding"],
    ["https://fr-fr.facebook.com/acme", "facebook", "https://www.facebook.com/acme"],
    ["https://www.facebook.com/profile.php?id=1000123&ref=site", "facebook", "https://www.facebook.com/profile.php?id=1000123"],
    ["https://twitter.com/acme_fr", "x", "https://x.com/acme_fr"],
    ["https://x.com/acme_fr?s=21", "x", "https://x.com/acme_fr"],
  ])("reads %s", (href, kind, value) => {
    expect(socialProfile(href)).toEqual({ kind, value });
  });

  it.each([
    ["LinkedIn's share button", "https://www.linkedin.com/shareArticle?mini=true&url=https://acme.fr"],
    ["LinkedIn's other share button", "https://www.linkedin.com/sharing/share-offsite/?url=https://acme.fr"],
    ["LinkedIn's tracking pixel", "https://px.ads.linkedin.com/collect/?pid=1"],
    ["Facebook's share button", "https://www.facebook.com/sharer/sharer.php?u=https://acme.fr"],
    ["Facebook's other share button", "https://facebook.com/share.php?u=https://acme.fr"],
    ["Facebook's tracking pixel", "https://www.facebook.com/tr?id=1&ev=PageView"],
    ["Facebook's redirect", "https://l.facebook.com/l.php?u=https://acme.fr"],
    ["X's share button", "https://twitter.com/intent/tweet?url=https://acme.fr"],
    ["X's other share button", "https://x.com/share?url=https://acme.fr"],
    ["someone's post on X", "https://x.com/journaliste/status/123"],
    ["a post on Instagram", "https://www.instagram.com/p/abc/"],
    ["a shortener", "https://t.co/abc"],
    ["LinkedIn's shortener", "https://lnkd.in/abc"],
    ["a look-alike", "https://www.notlinkedin.com/in/ada"],
    ["a mention in a path", "https://acme.fr/linkedin.com/in/ada"],
    ["a mailto", "mailto:ada@linkedin.com"],
    ["a relative link", "/linkedin"],
  ])("leaves out %s", (_, href) => {
    expect(socialProfile(href)).toBeNull();
  });

  it("finds them in a page's links, with protocol-relative ones", () => {
    const found = contactsIn('<a href="//www.instagram.com/acme/">Instagram</a><a href="https://www.facebook.com/sharer/sharer.php?u=x">Partager</a>', `${SITE}/`);

    expect(found).toEqual([{ kind: "instagram", value: "https://www.instagram.com/acme", page: `${SITE}/` }]);
  });
});

describe("the address of a company's site", () => {
  it.each([
    ["acme.fr", "https://acme.fr/"],
    ["http://www.acme.fr/equipe", "https://www.acme.fr/equipe"],
    ["  https://acme.fr  ", "https://acme.fr/"],
    ["ÉTÉ.fr", "https://xn--t-9fab.fr/"],
  ])("reads %s", (written, href) => {
    expect(httpsUrl(written)?.href).toBe(href);
  });

  it.each(["", "pas un site", "ftp://acme.fr", "localhost", "http://127.0.0.1", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "https://acme.fr:8443", "https://user:pw@acme.fr", "intranet.local", "serveur.internal", "mailto:a@acme.fr"])("refuses %s, which is no company's site", (written) => {
    expect(httpsUrl(written)).toBeNull();
  });
});

describe("robots.txt", () => {
  const allows = (rules: string, path: string) => robotsAllows(parseRobots(rules, "Coldlyne"), new URL(path, SITE));

  it("obeys the group naming Coldlyne before the one for everyone, whatever its case", () => {
    const rules = "User-agent: *\nDisallow: /\n\nUser-Agent: COLDLYNE\nDisallow: /prive\n";

    expect(allows(rules, "/contact")).toBe(true);
    expect(allows(rules, "/prive/x")).toBe(false);
  });

  it("merges the groups naming Coldlyne, and reads a group of several agents", () => {
    const rules = "User-agent: autre\nUser-agent: coldlyne/1.0\nDisallow: /a\n\nUser-agent: Coldlyne\nDisallow: /b\n\nUser-agent: *\nDisallow: /c\n";

    expect([allows(rules, "/a"), allows(rules, "/b"), allows(rules, "/c")]).toEqual([false, false, true]);
  });

  it("takes an empty group naming Coldlyne to allow everything", () => {
    expect(allows("User-agent: coldlyne\nDisallow:\n\nUser-agent: *\nDisallow: /\n", "/contact")).toBe(true);
  });

  it("falls back on the group for everyone, and allows what no rule mentions", () => {
    expect(allows("User-agent: googlebot\nDisallow: /\n", "/contact")).toBe(true);
    expect(allows("# rien\nDisallow: /orpheline\nUser-agent: *\nDisallow: /a # commentaire\nSitemap: https://acme.fr/s.xml\n", "/orpheline")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /a # commentaire\n", "/a/b")).toBe(false);
  });

  it("lets the most specific rule win, and an allow win a tie", () => {
    const rules = "User-agent: *\nDisallow: /docs/\nAllow: /docs/contact\nAllow: /egal\nDisallow: /egal\n";

    expect(allows(rules, "/docs/x")).toBe(false);
    expect(allows(rules, "/docs/contact")).toBe(true);
    expect(allows(rules, "/egal")).toBe(true);
  });

  it("understands * and $, and takes other characters literally", () => {
    const rules = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /p*/secret\nDisallow: /a.b\n";

    expect(allows(rules, "/x/doc.pdf")).toBe(false);
    expect(allows(rules, "/x/doc.pdf?v=1")).toBe(true);
    expect(allows(rules, "/prive/secret/1")).toBe(false);
    expect(allows(rules, "/axb")).toBe(true);
  });

  it("reads queries too", () => {
    expect(allows("User-agent: *\nDisallow: /*?page=\n", "/liste?page=2")).toBe(false);
  });

  it("has nothing to say when there are no rules", () => {
    expect(robotsAllows(EVERYTHING_ALLOWED, new URL("/x", SITE))).toBe(true);
  });
});

describe("reading a company's site", () => {
  const HOME = `<html><body>
    <a href="/contact">Nous contacter</a>
    <a href="/mentions-legales">Mentions légales</a>
    <a href="https://www.acme.fr/equipe#haut">L'équipe</a>
    <a href="/a_propos">À propos</a>
    <a href="/blog">Blog</a>
    <a href="https://ailleurs.fr/contact">Contact chez un autre</a>
    <a href="/plaquette-contact.pdf">Plaquette</a>
    <a href="https://www.linkedin.com/company/acme/">LinkedIn</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=https://acme.fr">Partager</a>
    <a href="mailto:contact@acme.fr">Écrire</a>
  </body></html>`;

  it("reads the home page and the pages likely to say how to reach the company, each finding with its page", async () => {
    const { fetch, calls } = site({
      "/contact": '<p>Écrivez à contact@acme.fr ou jeanne [at] acme.fr</p><p>Tél : 01 23 45 67 89</p><a href="https://www.linkedin.com/company/acme">LinkedIn</a>',
      "/mentions-legales": "<p>Directrice de la publication : paul@acme.fr, 04 72 00 00 00</p>",
      "/a_propos": '<a href="https://www.instagram.com/acme/">Instagram</a>',
      "/": HOME,
    });
    // The team page lives on www, which is the same site.
    const withWww = ((input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith("https://www.acme.fr/equipe") ? Promise.resolve(new Response("<p>marie@acme.fr</p>", { headers: { "content-type": "text/html" } })) : String(input) === "https://www.acme.fr/robots.txt" ? Promise.resolve(new Response("", { status: 404 })) : fetch(input, init))) as typeof globalThis.fetch;

    const reading = await readCompanyWebsite("acme.fr", { fetch: withWww });

    expect(reading.pagesRead).toEqual([`${SITE}/`, `${SITE}/contact`, `${SITE}/mentions-legales`, "https://www.acme.fr/equipe", `${SITE}/a_propos`]);
    expect(reading.findings).toEqual([
      { kind: "email", value: "contact@acme.fr", page: `${SITE}/` },
      { kind: "linkedin", value: "https://www.linkedin.com/company/acme", page: `${SITE}/` },
      { kind: "email", value: "jeanne@acme.fr", page: `${SITE}/contact` },
      { kind: "phone", value: "+33123456789", page: `${SITE}/contact` },
      { kind: "email", value: "paul@acme.fr", page: `${SITE}/mentions-legales` },
      { kind: "phone", value: "+33472000000", page: `${SITE}/mentions-legales` },
      { kind: "email", value: "marie@acme.fr", page: "https://www.acme.fr/equipe" },
      { kind: "instagram", value: "https://www.instagram.com/acme", page: `${SITE}/a_propos` },
    ]);
    expect(asked(calls)).not.toContain("/blog");
    expect(calls.map(({ url }) => url).join()).not.toMatch(/linkedin|facebook|instagram|ailleurs/);
  });

  it("says who is asking and gives up after 5 seconds, on every request", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetch, calls } = site({ "/": "<p>Rien</p>" });

    await readCompanyWebsite(SITE, { fetch });

    expect(calls.length).toBeGreaterThan(1);
    expect(new Set(calls.map(({ headers }) => headers.get("user-agent")))).toEqual(new Set(["Coldlyne (+https://coldlyne.com/robot)"]));
    expect(timeout).toHaveBeenCalledWith(5000);
    timeout.mockRestore();
  });

  it("reads at most 6 pages, however many are tempting", async () => {
    const links = ["contact", "contact-2", "contact-3", "mentions", "mentions-2", "equipe", "equipe-2", "a-propos", "a-propos-2"].map((path) => `<a href="/${path}">${path}</a>`).join("");
    const { fetch, calls } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 404 },
      { match: `GET ${SITE}/`, text: `<html>${links}</html>`, headers: { "content-type": "text/html" } },
    ]);

    const reading = await readCompanyWebsite(SITE, { fetch });

    const pages = calls.filter(({ url }) => !url.endsWith("/robots.txt"));
    expect(pages).toHaveLength(6);
    // Each kind of page gets its turn before any gets a second.
    expect(pages.slice(1, 5).map(({ url }) => url)).toEqual([`${SITE}/contact`, `${SITE}/mentions`, `${SITE}/equipe`, `${SITE}/a-propos`]);
    expect(reading.pagesRead).toHaveLength(6);
  });

  it("tries common paths when the home page links to nothing, and notes what isn't there", async () => {
    const { fetch, calls } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 404 },
      { match: `GET ${SITE}/contact`, text: "<p>contact@acme.fr</p>", headers: { "content-type": "text/html" } },
      { match: `GET ${SITE}/mentions-legales`, status: 404 },
      { match: `GET ${SITE}/equipe`, status: 404 },
      { match: `GET ${SITE}/a-propos`, status: 500 },
      { match: `GET ${SITE}/nous-contacter`, status: 404 },
      { match: `GET ${SITE}/`, text: "<p>Bienvenue</p>", headers: { "content-type": "text/html" } },
    ]);

    const reading = await readCompanyWebsite(SITE, { fetch });

    expect(asked(calls).filter((path) => path !== "/robots.txt")).toEqual(["/", "/contact", "/mentions-legales", "/equipe", "/a-propos", "/nous-contacter"]);
    expect(reading.findings).toEqual([{ kind: "email", value: "contact@acme.fr", page: `${SITE}/contact` }]);
    expect(reading.skipped).toContainEqual({ page: `${SITE}/equipe`, why: "not_found" });
  });

  it("keeps a detail's first page when several pages show it", async () => {
    const { fetch } = site({ "/contact": "<p>contact@acme.fr</p>", "/": '<a href="/contact">Contact</a><a href="/mentions-legales">Légal</a><p>contact@acme.fr</p>' });

    const { findings } = await readCompanyWebsite(SITE, { fetch });

    expect(findings).toEqual([{ kind: "email", value: "contact@acme.fr", page: `${SITE}/` }]);
  });

  it("honours robots.txt: a forbidden page isn't asked for", async () => {
    const { fetch, calls } = site({ "/contact": "<p>contact@acme.fr</p>", "/mentions-legales": "<p>legal@acme.fr</p>", "/": '<a href="/contact">Contact</a><a href="/mentions-legales">Légal</a>' }, { match: `GET ${SITE}/robots.txt`, text: "User-agent: *\nDisallow: /contact\n" });

    const reading = await readCompanyWebsite(SITE, { fetch });

    expect(asked(calls)).not.toContain("/contact");
    expect(reading.skipped).toContainEqual({ page: `${SITE}/contact`, why: "robots" });
    expect(reading.findings.map(({ value }) => value)).toEqual(["legal@acme.fr"]);
    expect(calls.filter(({ url }) => url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("reads nothing at all when robots.txt says so", async () => {
    const { fetch, calls } = site({ "/": "<p>contact@acme.fr</p>" }, { match: `GET ${SITE}/robots.txt`, text: "User-agent: Coldlyne\nDisallow: /\n" });

    expect(await readCompanyWebsite(SITE, { fetch })).toEqual({ findings: [], pagesRead: [], skipped: [{ page: `${SITE}/`, why: "robots" }] });
    expect(asked(calls)).toEqual(["/robots.txt"]);
  });

  it.each([
    ["answers with a server error", { match: `GET ${SITE}/robots.txt`, status: 503 }],
    ["redirects to another site", { match: `GET ${SITE}/robots.txt`, status: 301, headers: { location: "https://cdn.ailleurs.fr/robots.txt" } }],
  ])("assumes nothing may be read when robots.txt %s", async (_, robots) => {
    const { fetch, calls } = site({ "/": "<p>contact@acme.fr</p>" }, robots);

    expect((await readCompanyWebsite(SITE, { fetch })).skipped).toEqual([{ page: `${SITE}/`, why: "robots" }]);
    expect(asked(calls)).not.toContain("/");
  });

  it("assumes nothing may be read when robots.txt can't be fetched", async () => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    expect((await readCompanyWebsite(SITE, { fetch: unreachable })).skipped).toEqual([{ page: `${SITE}/`, why: "robots" }]);
  });

  it("gives up on a page that doesn't answer in time, and reads the others", async () => {
    const hanging = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/contact"))
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      if (url === `${SITE}/`) return new Response('<a href="/contact">Contact</a><a href="/mentions-legales">Légal</a>', { headers: { "content-type": "text/html" } });
      return new Response("<p>legal@acme.fr</p>", { headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    const reading = await readCompanyWebsite(SITE, { fetch: hanging, timeoutMs: 10 });

    expect(reading.skipped).toContainEqual({ page: `${SITE}/contact`, why: "unreachable" });
    expect(reading.findings.map(({ value }) => value)).toContain("legal@acme.fr");
  });

  it("follows a redirect within the site, and keeps the page it landed on", async () => {
    const { fetch, calls } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 301, headers: { location: "https://www.acme.fr/robots.txt" } },
      { match: "GET https://www.acme.fr/robots.txt", status: 404 },
      { match: `GET ${SITE}/`, status: 301, headers: { location: "https://www.acme.fr/" } },
      { match: "GET https://www.acme.fr/", text: "<p>contact@acme.fr</p>", headers: { "content-type": "text/html" } },
    ]);

    const { findings, pagesRead } = await readCompanyWebsite(SITE, { fetch });

    expect(pagesRead[0]).toBe("https://www.acme.fr/");
    expect(findings[0]).toEqual({ kind: "email", value: "contact@acme.fr", page: "https://www.acme.fr/" });
    expect(calls.every(({ headers }) => headers.get("user-agent")?.startsWith("Coldlyne"))).toBe(true);
  });

  it("never follows a redirect to a social platform or another site", async () => {
    const { fetch, calls } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 404 },
      { match: `GET ${SITE}/`, status: 302, headers: { location: "https://www.facebook.com/acme" } },
    ]);

    expect(await readCompanyWebsite(SITE, { fetch })).toEqual({ findings: [], pagesRead: [], skipped: [{ page: `${SITE}/`, why: "other_site" }] });
    expect(calls.map(({ url }) => url).join()).not.toContain("facebook");
  });

  it("gives up on a page that redirects without end", async () => {
    const { fetch } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 404 },
      { match: `GET ${SITE}/`, status: 302, headers: { location: `${SITE}/` } },
    ]);

    expect((await readCompanyWebsite(SITE, { fetch })).skipped).toEqual([{ page: `${SITE}/`, why: "too_many_redirects" }]);
  });

  it("reads only web pages", async () => {
    const { fetch } = fakeFetch([
      { match: `GET ${SITE}/robots.txt`, status: 404 },
      { match: `GET ${SITE}/`, text: "contact@acme.fr", headers: { "content-type": "application/pdf" } },
    ]);

    expect(await readCompanyWebsite(SITE, { fetch })).toEqual({ findings: [], pagesRead: [], skipped: [{ page: `${SITE}/`, why: "not_html" }] });
  });

  it("doesn't let a page nest deep enough to stall the parser", async () => {
    const { fetch } = site({ "/": `${"<div>".repeat(300_000)}contact@acme.fr` });

    expect(await readCompanyWebsite(SITE, { fetch })).toEqual({ findings: [], pagesRead: [], skipped: [{ page: `${SITE}/`, why: "unreadable" }] });
  });

  it("reads a long page of closed elements and of void ones, however many", async () => {
    const { fetch } = site({ "/": `${"<div><img><br></div>".repeat(20_000)}<p>contact@acme.fr</p>` });

    expect((await readCompanyWebsite(SITE, { fetch })).findings).toEqual([{ kind: "email", value: "contact@acme.fr", page: `${SITE}/` }]);
  });

  it("isn't slowed down by what a hostile page repeats", () => {
    const started = Date.now();
    for (const page of ["A".repeat(1_000_000), " ".repeat(1_000_000), "a@".repeat(500_000), `a@b${".c".repeat(500_000)}`, "01 ".repeat(300_000), '<a href="/contact">x</a>'.repeat(40_000)]) contactsIn(page, `${SITE}/`);

    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads the start of a page too long to hold", async () => {
    const huge = `<p>debut@acme.fr</p>${" ".repeat(2_100_000)}<p>fin@acme.fr</p>`;
    const { fetch } = site({ "/": huge });

    const { findings } = await readCompanyWebsite(SITE, { fetch });

    expect(findings.map(({ value }) => value)).toEqual(["debut@acme.fr"]);
  });

  it.each(["https://www.facebook.com/acme", "linkedin.com/company/acme", "https://x.com/acme", "https://t.co/abc", "instagram.com/acme", "localhost", "http://192.168.1.1/admin", "pas un site"])("never fetches %s, which is no company's site", async (website) => {
    const { fetch, calls } = fakeFetch([]);

    expect(await readCompanyWebsite(website, { fetch })).toEqual({ findings: [], pagesRead: [], skipped: [{ page: website, why: "not_a_company_site" }] });
    expect(calls).toEqual([]);
  });
});
