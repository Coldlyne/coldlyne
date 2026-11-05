import { eq } from "drizzle-orm";
import { user } from "@/infrastructure/db/schema/auth";
import { openConnection } from "./connections";
import type { Services } from "./services";

/**
 * Proves a mailbox can send, by writing to the member who asks and to no one else: this path has
 * no caps, no window and no legal footer, so a prospect's address can never be given to it.
 */
export async function sendTestEmail(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<{ ok: true; to: string; from: string } | { ok: false; error: string }> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.sendEmail) return { ok: false, error: "Cette connexion n’envoie pas d’emails." };
  const [member] = await services.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!member) return { ok: false, error: "Votre compte est introuvable." };
  try {
    await opened.client.sendEmail({ to: member.email, subject: "Test Coldlyne", text: `Cette boîte peut envoyer des emails depuis Coldlyne.\n\nEnvoyé depuis ${opened.row.label}.`, headers: {} });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "L’envoi a échoué." };
  }
  return { ok: true, to: member.email, from: opened.row.label };
}
