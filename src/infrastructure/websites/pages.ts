import { parsePage } from "@/domain/contacts";
import { plainLowercase } from "@/domain/words";

/**
 * The pages of a company's site most likely to say how to reach it. Links on the home page come
 * first, since they are real; a common path is tried only for what no link points to.
 */
const PAGE_KINDS: readonly { words: RegExp; commonPaths: readonly string[] }[] = [
  { words: /contact|nous-joindre/, commonPaths: ["/contact", "/nous-contacter"] },
  { words: /mentions|legal|imprint/, commonPaths: ["/mentions-legales", "/legal"] },
  { words: /equipe|team|fondateur|dirigeant/, commonPaths: ["/equipe", "/notre-equipe", "/team"] },
  { words: /a-propos|about|qui-sommes-nous|notre-histoire/, commonPaths: ["/a-propos", "/qui-sommes-nous", "/about"] },
];

const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i;

/** Real pages nest a few dozen elements deep. */
const DEEPEST_READABLE_NESTING = 5000;
const OPENING_OR_CLOSING_TAG = /<(\/?)(?!(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b)[a-z]/gi;

/**
 * Whether the parser can be given this page. Its time grows with the square of the nesting, so a
 * page of nothing but opening tags could stall the server for minutes: measured here in one pass.
 */
export function isReadablePage(html: string): boolean {
  let depth = 0;
  for (const [, closing] of html.matchAll(OPENING_OR_CLOSING_TAG)) {
    depth = closing ? Math.max(0, depth - 1) : depth + 1;
    if (depth > DEEPEST_READABLE_NESTING) return false;
  }
  return true;
}

/** Whether two addresses are the same site: acme.fr and www.acme.fr are. */
export const isSameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

/** "À propos" and /a_propos read the same way. */
const simplified = (text: string) => plainLowercase(text).replace(/[\s_]+/g, "-");

/** The site's own pages a page links to, with what each link says. */
function linksOn(html: string, page: URL): { url: URL; label: string }[] {
  return parsePage(html)
    .getElementsByTagName("a")
    .flatMap((link) => {
      const href = link.getAttribute("href");
      if (!href || !URL.canParse(href, page)) return [];
      const url = new URL(href, page);
      url.hash = "";
      if (!/^https?:$/.test(url.protocol) || !isSameSite(url, page) || NOT_A_PAGE.test(url.pathname)) return [];
      return [{ url, label: simplified(`${url.pathname} ${link.text}`) }];
    });
}

/** Up to `limit` pages to read next, taking each kind's best first so that one kind can't use them all up. */
export function likelyPages(homeHtml: string, home: URL, limit: number): URL[] {
  const links = linksOn(homeHtml, home);
  const byKind = PAGE_KINDS.map(({ words, commonPaths }) => {
    const linked = links.filter(({ label }) => words.test(label)).map(({ url }) => url);
    return linked.length ? linked.slice(0, limit) : commonPaths.map((path) => new URL(path, home));
  });
  const longest = Math.max(...byKind.map((pages) => pages.length));
  const ranked = Array.from({ length: longest }, (_, rank) => byKind.flatMap((pages) => pages[rank] ?? [])).flat();
  const unseen = ranked.filter((url, index) => url.pathname !== home.pathname && ranked.findIndex((other) => other.href === url.href) === index);
  return unseen.slice(0, limit);
}
