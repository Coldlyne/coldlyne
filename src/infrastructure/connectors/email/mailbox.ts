import type { Check } from "@/application/ports";
import { ProviderError } from "../http";

/** The mailbox a connection sends from and reads. */
export interface Mailbox {
  address: string;
  /** The name shown beside the address, when the member gave one. */
  name?: string;
}

/** The mailbox saved with the connection: typed by the member, or the address `check` found. */
export function mailboxOf(fields: Readonly<Record<string, string>>): Mailbox {
  if (!fields.address) throw new Error("L’adresse de cette boîte manque\u00a0: reconnectez-la.");
  return { address: fields.address, name: fields.displayName };
}

/** The answer to a connection check: the mailbox's address once proven, or why it couldn't be. */
export async function checkMailbox(provider: string, proveAddress: () => Promise<string>): Promise<Check> {
  try {
    const address = (await proveAddress()).toLowerCase();
    return { ok: true, detail: `boîte ${address}`, label: address };
  } catch (error) {
    return { ok: false, detail: error instanceof ProviderError ? error.message : `Impossible de vérifier ${provider}\u00a0: ${(error as Error).message}` };
  }
}
