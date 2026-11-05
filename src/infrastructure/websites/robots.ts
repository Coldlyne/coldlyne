/**
 * What a site's robots.txt lets Coldlyne read, by the Robots Exclusion Protocol:
 * https://www.rfc-editor.org/rfc/rfc9309.html
 */
export interface RobotsRules {
  allow: readonly string[];
  disallow: readonly string[];
}

/** No robots.txt (a 4xx answer): anything may be read. */
export const EVERYTHING_ALLOWED: RobotsRules = { allow: [], disallow: [] };
/** A robots.txt that can't be fetched (a 5xx answer, no answer): nothing may be read until it can. */
export const NOTHING_ALLOWED: RobotsRules = { allow: [], disallow: ["/"] };

/** A longer pattern is someone's mistake or a trap, and matching it is slow. */
const LONGEST_PATTERN = 512;

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
}

const DIRECTIVE = /^\s*([a-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/i;

/** The file's groups: consecutive user-agent lines share the rules that follow them. */
function groupsIn(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let inRules = false;
  for (const line of text.split(/\r?\n/)) {
    const [, key, value = ""] = DIRECTIVE.exec(line) ?? [];
    const directive = key?.toLowerCase();
    if (directive === "user-agent") {
      if (!current || inRules) groups.push((current = { agents: [], allow: [], disallow: [] }));
      current.agents.push(value.toLowerCase());
      inRules = false;
    } else if (current && (directive === "allow" || directive === "disallow")) {
      inRules = true;
      if (value && value.length <= LONGEST_PATTERN) current[directive].push(value);
    }
  }
  return groups;
}

/** The groups naming this crawler, merged; otherwise those for every crawler. */
export function parseRobots(text: string, productToken: string): RobotsRules {
  const groups = groupsIn(text);
  const named = groups.filter(({ agents }) => agents.some((agent) => agent.split("/")[0] === productToken.toLowerCase()));
  const applying = named.length ? named : groups.filter(({ agents }) => agents.includes("*"));
  return { allow: applying.flatMap(({ allow }) => allow), disallow: applying.flatMap(({ disallow }) => disallow) };
}

function matchesPath(pattern: string, path: string): boolean {
  const anchoredAtEnd = pattern.endsWith("$");
  const body = anchoredAtEnd ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}${anchoredAtEnd ? "$" : ""}`).test(path);
}

const longestMatch = (patterns: readonly string[], path: string) => Math.max(-1, ...patterns.filter((pattern) => matchesPath(pattern, path)).map((pattern) => pattern.length));

/** The most specific rule wins, and an allow wins a tie. */
export function robotsAllows(rules: RobotsRules, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  return longestMatch(rules.allow, path) >= longestMatch(rules.disallow, path);
}
