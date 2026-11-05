import type { Check } from "@/application/ports";
import { ProviderError } from "./http";

/**
 * Runs a connection's check: what the service refuses becomes the reason the member reads, and
 * anything else (no network, an unreadable answer) is said in their words too, never as a raw
 * error in English.
 */
export async function checked(provider: string, run: () => Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (error) {
    return { ok: false, detail: error instanceof ProviderError ? error.message : `${provider} ne répond pas correctement pour le moment.` };
  }
}

/** What a check says of a prepaid balance. A currency Intl doesn't know is shown as the provider wrote it. */
export function balanceOf(amount: number, currency: string): string {
  try {
    return `Solde : ${new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(amount)}`;
  } catch {
    return `Solde : ${amount} ${currency}`;
  }
}
