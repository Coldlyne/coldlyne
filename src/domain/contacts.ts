import { HTMLElement, NodeType, parse, type Node } from "node-html-parser";
import { frenchPhoneE164 } from "./french-numbers";

/**
 * The contact details a company publishes on its own site, each with the page that shows it, so a
 * member can check it before confirming. Only what is written is kept: an address is never built
 * from a name, and a platform is never visited, only the links that point to it.
 */
export type ContactKind = "email" | "phone" | "linkedin" | "instagram" | "facebook" | "x";

export interface ContactFinding {
  kind: ContactKind;
  /** A lowercased address, an E.164 number, or a profile's canonical URL. */
  value: string;
  /** The page it was found on. */
  page: string;
}

/** A page as Coldlyne reads it: what scripts and styles contain isn't something the company wrote for people. */
export const parsePage = (html: string) => parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });

/** Every contact detail on a page, once each. */
export function contactsIn(html: string, page: string): ContactFinding[] {
  const root = parsePage(html);
  const text = textOf(root).replace(/\s+/g, " ");
  const hrefs = root.getElementsByTagName("a").flatMap((link) => link.getAttribute("href") ?? []);
  const emails = [...hrefs.flatMap(emailsInMailto), ...emailsInText(text)].map((value) => ({ kind: "email" as const, value }));
  const phones = [...hrefs.flatMap(phoneInTelLink), ...phonesInText(text)].map((value) => ({ kind: "phone" as const, value }));
  const profiles = hrefs.flatMap((href) => (URL.canParse(href, page) ? (socialProfile(new URL(href, page).href) ?? []) : []));
  return dedupedFindings([...emails, ...phones, ...profiles].map((found) => ({ ...found, page })));
}

/** The same detail found twice keeps its first page: the home page is read first, the most official one. */
export function dedupedFindings(findings: readonly ContactFinding[]): ContactFinding[] {
  const byDetail = new Map<string, ContactFinding>();
  for (const finding of findings) {
    const detail = `${finding.kind}:${finding.value}`;
    if (!byDetail.has(detail)) byDetail.set(detail, finding);
  }
  return [...byDetail.values()];
}

/** A detail a workspace brought from its own file and that a page also shows is one detail: it keeps the page, which says where it comes from. */
export function onePerDetail<T extends { personId?: string; kind: string; value: string; page: string | null }>(details: readonly T[]): T[] {
  const byDetail = new Map<string, T>();
  for (const detail of details) {
    const key = `${detail.personId ?? ""}:${detail.kind}:${detail.value}`;
    const known = byDetail.get(key);
    if (!known || (!known.page && detail.page)) byDetail.set(key, detail);
  }
  return [...byDetail.values()];
}

/** The words of a page, spaced at element boundaries: two adjacent spans must not read as one word. */
function textOf(node: Node): string {
  if (node instanceof HTMLElement) return node.childNodes.map(textOf).join(" ");
  return node.nodeType === NodeType.TEXT_NODE ? node.text : "";
}

// ─── Emails ────────────────────────────────────────────────────────────────

/**
 * Bounded by what an address can be (64 characters before the @, RFC 5321): unbounded, a page of
 * base64 makes the search quadratic, which a hostile site could use to stall the server.
 */
const EMAIL_SHAPE = "[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,4}\\.[a-z]{2,24}";
const EMAIL = new RegExp(`^${EMAIL_SHAPE}$`);
const EMAIL_IN_TEXT = new RegExp(`(?<![a-z0-9._%+-])${EMAIL_SHAPE}`, "gi");

/** A lowercased address, or null when the text isn't one. */
export function normalizedEmail(text: string): string | null {
  const address = text.trim().toLowerCase();
  return EMAIL.test(address) ? address : null;
}

/** "logo@2x.png" looks like an address to a regular expression, and retina images are named that way. */
const FILE_ENDING = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|map|pdf|woff2?)$/;
/** Addresses in form placeholders and error reporters' snippets, not the company's own. */
const PLACEHOLDER_DOMAIN = /@(?:(?:[a-z0-9-]+\.)?wixpress\.com|sentry\.io|(?:[a-z0-9-]+\.)?(?:example|exemple|domain|domaine|votredomaine|yourdomain|email)\.[a-z]{2,})$/;
const PLACEHOLDER_NAME = /^(?:prenom\.nom|nom\.prenom|votre\.?-?(?:e-?mail|adresse|nom)|your\.?-?(?:e-?mail|name)|email|e-mail|you|nom)@/;
/** Nobody reads these: a message sent there goes nowhere. */
const UNATTENDED = /^(?:no-?reply|do-?not-?reply|ne-?pas-?repondre)@/;

const isReachableAddress = (address: string) => !FILE_ENDING.test(address) && !PLACEHOLDER_DOMAIN.test(address) && !PLACEHOLDER_NAME.test(address) && !UNATTENDED.test(address);

function emailsInMailto(href: string): string[] {
  if (!/^mailto:/i.test(href)) return [];
  const recipients = decodedOrRaw(href.slice("mailto:".length).split("?")[0]);
  return recipients.split(/[,;]/).flatMap((recipient) => normalizedEmail(recipient) ?? []).filter(isReachableAddress);
}

function decodedOrRaw(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The text reaching these has its spaces collapsed, so a single optional space is all they need.
const OBFUSCATED_AT = / ?(?:[[({] ?(?:at|arobase|chez|@) ?[\])}]|\barobase\b| @ ) ?/gi;
const OBFUSCATED_DOT = / ?[[({] ?(?:dot|point) ?[\])}] ?/gi;
/** Only before the domain has its dot: after a whole address, "point de vente" is French, not punctuation. */
const SPELLED_OUT_DOT = /(@[a-z0-9-]{1,63}) (?:point|dot) (?=[a-z])/gi;

/** "contact [at] acme (point) fr" and "contact arobase acme point fr" are how sites hide an address from scrapers but not from people. */
function withAddressesSpelledNormally(text: string): string {
  return text.replace(OBFUSCATED_AT, "@").replace(OBFUSCATED_DOT, ".").replace(SPELLED_OUT_DOT, "$1.");
}

function emailsInText(text: string): string[] {
  const found = withAddressesSpelledNormally(text).match(EMAIL_IN_TEXT) ?? [];
  return found.flatMap((address) => normalizedEmail(address) ?? []).filter(isReachableAddress);
}

// ─── Phones ────────────────────────────────────────────────────────────────

const SEPARATOR = "[ .\\-]";
const NATIONAL_PHONE = `0[1-9](?:${SEPARATOR}?\\d{2}){4}`;
const INTERNATIONAL_PHONE = `\\(?(?:\\+|00)33\\)?${SEPARATOR}*(?:\\(0\\)${SEPARATOR}*)?[1-9](?:${SEPARATOR}?\\d{2}){4}`;
const OVERSEAS_PHONE = `(?:\\+|00)(?:262|590|594|596)${SEPARATOR}*(?:\\(0\\)${SEPARATOR}*)?\\d{3}(?:${SEPARATOR}?\\d{2}){3}`;
/** Pairs of digits, as French numbers are written: a run inside longer digits (a SIRET, an order number) doesn't qualify. */
const PHONE_IN_TEXT = new RegExp(`(?<![\\d+])(?:${OVERSEAS_PHONE}|${INTERNATIONAL_PHONE}|${NATIONAL_PHONE})(?!\\d)`, "g");
/** A fax number is published next to the phone, and nobody picks it up. */
const ANNOUNCED_AS_FAX = /\b(?:fax|t[ée]l[ée]copie)\b\W{0,4}$/i;

function phonesInText(text: string): string[] {
  return [...text.matchAll(PHONE_IN_TEXT)].flatMap((match) => {
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    return ANNOUNCED_AS_FAX.test(before) ? [] : (frenchPhoneE164(match[0]) ?? []);
  });
}

function phoneInTelLink(href: string): string[] {
  const phone = /^tel:/i.test(href) ? frenchPhoneE164(decodedOrRaw(href.slice("tel:".length))) : null;
  return phone ? [phone] : [];
}

// ─── Profiles ──────────────────────────────────────────────────────────────

type SocialKind = Extract<ContactKind, "linkedin" | "instagram" | "facebook" | "x">;

interface Platform {
  kind: SocialKind;
  domains: readonly string[];
  /** Subdomains that serve profiles; the others serve ads, redirects and developers' pages. */
  subdomains: RegExp;
  /**
   * The canonical profile URL behind a link's path, or null for anything else: a share button, a
   * tracking pixel, or someone else's post the site merely quotes.
   */
  profile: (segments: readonly string[], url: URL) => string | null;
}

const INSTAGRAM_PAGES = new Set(["explore", "share", "accounts", "direct", "about", "developer", "legal"]);
const FACEBOOK_PAGES = new Set(["sharer", "sharer.php", "share", "share.php", "dialog", "plugins", "tr", "login", "login.php", "l.php", "home.php", "marketplace", "watch", "gaming", "hashtag", "policies", "help", "privacy", "terms", "ads", "business", "settings"]);
const X_PAGES = new Set(["intent", "share", "home", "search", "hashtag", "explore", "login", "signup", "settings", "tos", "privacy", "about"]);

const PLATFORMS: readonly Platform[] = [
  {
    kind: "linkedin",
    domains: ["linkedin.com"],
    subdomains: /^(?:www|[a-z]{2})$/,
    profile: ([section, slug]) => ((section === "company" || section === "in") && slug ? `https://www.linkedin.com/${section}/${slug}` : null),
  },
  {
    kind: "instagram",
    domains: ["instagram.com"],
    subdomains: /^www$/,
    profile: ([handle, ...rest]) => (handle && !rest.length && /^[a-z0-9._]+$/.test(handle) && !INSTAGRAM_PAGES.has(handle) ? `https://www.instagram.com/${handle}` : null),
  },
  {
    kind: "facebook",
    domains: ["facebook.com", "fb.com"],
    subdomains: /^(?:www|web|m|[a-z]{2}(?:-[a-z]{2})?)$/,
    profile: ([page, ...rest], url) => {
      const profileId = url.searchParams.get("id");
      if (page === "profile.php") return profileId ? `https://www.facebook.com/profile.php?id=${profileId}` : null;
      return page && !rest.length && !FACEBOOK_PAGES.has(page) ? `https://www.facebook.com/${page}` : null;
    },
  },
  {
    kind: "x",
    domains: ["x.com", "twitter.com"],
    subdomains: /^(?:www|mobile)$/,
    profile: ([handle, ...rest]) => (handle && !rest.length && /^[a-z0-9_]{1,15}$/.test(handle) && !X_PAGES.has(handle) ? `https://x.com/${handle}` : null),
  },
];

function platformOf(url: URL): Platform | undefined {
  return PLATFORMS.find(({ domains, subdomains }) =>
    domains.some((domain) => url.hostname === domain || (url.hostname.endsWith(`.${domain}`) && subdomains.test(url.hostname.slice(0, -domain.length - 1)))),
  );
}

/** A link to a company's or a person's profile, in its canonical form: no tracking parameters, one spelling. Null for anything else. */
export function socialProfile(href: string): { kind: SocialKind; value: string } | null {
  const url = URL.canParse(href) ? new URL(href) : null;
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const platform = platformOf(url);
  if (!platform) return null;
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  const value = platform.profile(segments, url);
  return value ? { kind: platform.kind, value } : null;
}

/** Hosts Coldlyne must never read: their terms forbid it, and their pages need a signed-in visitor anyway. */
const SOCIAL_DOMAINS = [...PLATFORMS.flatMap(({ domains }) => domains), "t.co", "lnkd.in", "instagr.am", "fb.me"];

export const isSocialHost = (hostname: string) => SOCIAL_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));

// ─── Addresses of sites ────────────────────────────────────────────────────

const REAL_LOOKING_HOST = /^[a-z0-9.-]+\.[a-z][a-z0-9-]*[a-z0-9]$/;
const LOCAL_HOST = /\.(?:local|localhost|internal|intranet|lan|home|corp)$/;

/**
 * "acme.fr", "http://www.acme.fr/" and the like as an https URL; null when it can't be a company's
 * site. A bare IP address, a local name, a port or embedded credentials never are, and refusing them
 * keeps a typed address from pointing Coldlyne's servers at their own network.
 */
export function httpsUrl(text: string): URL | null {
  const written = text.trim();
  if (!written || /\s/.test(written)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(written) ? written : `https://${written}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  if (!/^https?:$/.test(url.protocol) || url.port || url.username || url.password) return null;
  if (!REAL_LOOKING_HOST.test(url.hostname) || LOCAL_HOST.test(url.hostname)) return null;
  url.protocol = "https:";
  return url;
}

/** The site's bare host, "acme.fr" for "https://www.acme.fr/offres", or null. */
export function siteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Everyone's mailbox, not a company's: sharing one of these domains says nothing of who someone works for. */
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.fr",
  "hotmail.com",
  "hotmail.fr",
  "live.com",
  "live.fr",
  "msn.com",
  "yahoo.com",
  "yahoo.fr",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "laposte.net",
  "aol.com",
  "gmx.com",
  "gmx.fr",
  "bbox.fr",
  "neuf.fr",
  "yandex.com",
  "zoho.com",
]);

export const isPublicMailDomain = (domain: string) => PUBLIC_MAIL_DOMAINS.has(domain);
