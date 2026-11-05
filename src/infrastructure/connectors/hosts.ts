/** Hosts a member's address must not reach from inside Coldlyne's own network. */
const INTERNAL_HOST = /^(localhost|.*\.local|.*\.internal|\[.*\]|(0|10|127)\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

/** An IPv6 address, or one written as a bare or hexadecimal number: other ways to spell an internal host. */
const UNUSUAL_ADDRESS = /:|^\d+$|^0x/i;

export function isInternalHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  return !name || INTERNAL_HOST.test(name) || UNUSUAL_ADDRESS.test(name);
}
