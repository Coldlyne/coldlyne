/**
 * Where to go next: only a page of this app, so an address can't send a member elsewhere. Browsers
 * drop tabs and line breaks from an address, which would turn "/\t/evil.example" into another site.
 */
export const safeNext = (next: unknown) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !/[\t\r\n]/.test(next) ? next : "/");
