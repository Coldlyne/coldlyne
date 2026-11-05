import { contactsIn, dedupedFindings, httpsUrl, isSocialHost, type ContactFinding } from "@/domain/contacts";
import { isReadablePage, isSameSite, likelyPages } from "./pages";
import { EVERYTHING_ALLOWED, NOTHING_ALLOWED, parseRobots, robotsAllows, type RobotsRules } from "./robots";

/**
 * Reads a company's own site for how to reach it, as a polite visitor would: a handful of pages,
 * only those its robots.txt allows (https://www.rfc-editor.org/rfc/rfc9309.html), under a name that
 * says who is asking and links to why. Social platforms are never fetched, whatever the address
 * given: their terms forbid it, so a profile is only ever a link found on the company's site.
 */
const USER_AGENT = "Coldlyne (+https://coldlyne.com/robot)";
const PRODUCT_TOKEN = "Coldlyne";
const MAX_PAGES = 6;
const PAGE_TIMEOUT_MS = 5000;
/** RFC 9309 asks crawlers to follow at least five redirects for robots.txt. */
const MAX_REDIRECTS = 5;
/** Enough for any real page, and a bound on what a hostile one can make the server hold. */
const MAX_PAGE_BYTES = 2_000_000;
/** The least RFC 9309 asks a crawler to parse. */
const MAX_ROBOTS_BYTES = 500 * 1024;

/** Why a page wasn't read. */
export type SkipReason = "not_a_company_site" | "robots" | "other_site" | "unreachable" | "not_found" | "not_html" | "unreadable" | "too_many_redirects";

export interface WebsiteReading {
  findings: ContactFinding[];
  pagesRead: string[];
  skipped: { page: string; why: SkipReason }[];
}

export interface ReadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One visit to one site: its address, how to fetch, and the robots.txt of each host already asked. */
interface Visit {
  site: URL;
  fetch: typeof fetch;
  timeoutMs: number;
  robots: Map<string, Promise<RobotsRules>>;
}

/** The home page and the likeliest pages after it, and every contact detail found, each with its page. */
export async function readCompanyWebsite(website: string, { fetch: fetchUrl = fetch, timeoutMs = PAGE_TIMEOUT_MS }: ReadOptions = {}): Promise<WebsiteReading> {
  const site = httpsUrl(website);
  if (!site || isSocialHost(site.hostname)) return { findings: [], pagesRead: [], skipped: [{ page: website, why: "not_a_company_site" }] };
  const visit: Visit = { site, fetch: fetchUrl, timeoutMs, robots: new Map() };
  const reading: WebsiteReading = { findings: [], pagesRead: [], skipped: [] };
  const home = await readPage(site, visit, reading);
  if (!home) return reading;
  for (const page of likelyPages(home.html, home.url, MAX_PAGES - 1)) await readPage(page, visit, reading);
  return { ...reading, findings: dedupedFindings(reading.findings) };
}

/** Reads a page into the reading, and says so when it can't. */
async function readPage(url: URL, visit: Visit, reading: WebsiteReading): Promise<{ url: URL; html: string } | null> {
  const fetched = await fetchPage(url, visit);
  if ("why" in fetched) {
    reading.skipped.push({ page: url.href, why: fetched.why });
    return null;
  }
  reading.pagesRead.push(fetched.url.href);
  reading.findings.push(...contactsIn(fetched.html, fetched.url.href));
  return fetched;
}

async function fetchPage(start: URL, visit: Visit): Promise<{ url: URL; html: string } | { why: SkipReason }> {
  try {
    const { response, url } = await followRedirects(start, visit, (hop) => refusalOfPage(hop, visit));
    const why = !response.ok ? "not_found" : !/html/i.test(response.headers.get("content-type") ?? "") ? "not_html" : null;
    if (why) {
      await discard(response);
      return { why };
    }
    const html = await textUpTo(response, MAX_PAGE_BYTES);
    return isReadablePage(html) ? { url, html } : { why: "unreadable" };
  } catch (error) {
    return { why: error instanceof SkippedPage ? error.why : "unreachable" };
  }
}

async function refusalOfPage(url: URL, visit: Visit): Promise<SkipReason | null> {
  if (!isSameSite(url, visit.site)) return "other_site";
  return robotsAllows(await rulesFor(url, visit), url) ? null : "robots";
}

/** A body nobody will read holds its connection open until it's let go. */
const discard = (response: Response) => response.body?.cancel();

class SkippedPage extends Error {
  constructor(readonly why: SkipReason) {
    super(why);
  }
}

/**
 * A request whose redirects are followed by hand: left to `fetch`, a site's redirect could land on
 * a social platform or another company's site, which must not be read.
 */
async function followRedirects(start: URL, visit: Visit, refusal: (url: URL) => Promise<SkipReason | null>): Promise<{ response: Response; url: URL }> {
  let url = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const why = await refusal(url);
    if (why) throw new SkippedPage(why);
    const response = await visit.fetch(url.href, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" }, redirect: "manual", signal: AbortSignal.timeout(visit.timeoutMs) });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return { response, url };
    await discard(response);
    url = new URL(location, url);
  }
  throw new SkippedPage("too_many_redirects");
}

/** The rules for this host, fetched once per visit. */
function rulesFor(url: URL, visit: Visit): Promise<RobotsRules> {
  const known = visit.robots.get(url.origin);
  if (known) return known;
  const rules = fetchRobots(url, visit);
  visit.robots.set(url.origin, rules);
  return rules;
}

/** RFC 9309: 4xx means no restriction, and anything short of an answer means none may be assumed. */
async function fetchRobots(url: URL, visit: Visit): Promise<RobotsRules> {
  try {
    const { response } = await followRedirects(new URL("/robots.txt", url), visit, async (hop) => (isSameSite(hop, visit.site) ? null : "other_site"));
    if (response.ok) return parseRobots(await textUpTo(response, MAX_ROBOTS_BYTES), PRODUCT_TOKEN);
    await discard(response);
    return response.status >= 400 && response.status < 500 ? EVERYTHING_ALLOWED : NOTHING_ALLOWED;
  } catch {
    return NOTHING_ALLOWED;
  }
}

/** A response's text, cut off at this size. */
async function textUpTo(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}
