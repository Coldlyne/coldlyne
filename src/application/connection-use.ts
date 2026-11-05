import type { DnsRecord } from "@/domain/deliverability";
import { checkConnection, openConnection } from "./connections";
import type { CompanyFacts, DomainReputation } from "./ports";
import { syncConnection } from "./signals";
import type { Services } from "./services";
import { sendTestEmail } from "./test-email";

/**
 * Trying what a connection is for, from its page or from an assistant: each says in the member's
 * words what happened, and a service's refusal is an answer to show rather than a failure.
 */
export type Tried = { ok: true; said: string } | { ok: false; error: string };

const refusalOf = (error: unknown): Tried => ({ ok: false, error: error instanceof Error ? error.message : "Le service n’a pas répondu." });

const plural = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;

export async function tryTestEmail(services: Services, workspaceId: string, userId: string, connectionId: string): Promise<Tried> {
  const sent = await sendTestEmail(services, workspaceId, userId, connectionId);
  return sent.ok ? { ok: true, said: `Email envoyé à ${sent.to} depuis ${sent.from}\u00a0: regardez qu’il arrive bien, et pas en spam.` } : sent;
}

/** Proves an alert arrives, through a Slack channel or an outgoing webhook. */
export async function sendTestAlert(services: Services, workspaceId: string, connectionId: string): Promise<Tried> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.notify) return { ok: false, error: "Cette connexion n’envoie pas d’alertes." };
  try {
    await opened.client.notify({ event: "test", title: "Test Coldlyne", text: "Cette alerte arrive bien." });
  } catch (error) {
    return refusalOf(error);
  }
  return { ok: true, said: `Alerte envoyée par ${opened.row.label}.` };
}

/** Reads what arrived on one connection now, rather than at the next scheduled read. */
export async function readNow(services: Services, workspaceId: string, connectionId: string): Promise<Tried> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.signalsSince && !opened?.client.meetingsSince) return { ok: false, error: "Cette connexion ne se lit pas\u00a0: c’est le service qui écrit à Coldlyne." };
  const outcome = await syncConnection(services, workspaceId, opened);
  if ("why" in outcome) return { ok: false, error: outcome.why };
  const dropped = outcome.read > outcome.added ? " Coldlyne ne garde que ce qui concerne les personnes que vous avez contactées." : "";
  return { ok: true, said: `${plural(outcome.read, "élément lu", "éléments lus")}, ${plural(outcome.added, "nouveau retenu", "nouveaux retenus")}.${dropped}` };
}

/** Asks the service whether the connection still works, and says so. */
export async function tryCheck(services: Services, workspaceId: string, connectionId: string): Promise<Tried> {
  const checked = await checkConnection(services, workspaceId, connectionId);
  if (!checked) return { ok: false, error: "Cette connexion n’existe plus." };
  return checked.status === "connected" ? { ok: true, said: `${checked.label} répond.` } : { ok: false, error: checked.lastError ?? "Le service n’a pas répondu." };
}

/** Adds a record to a domain, or replaces the one of the same type and name, through a connected DNS. */
export async function publishRecord(services: Services, workspaceId: string, connectionId: string, domain: string, record: DnsRecord): Promise<Tried> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.upsertRecord) return { ok: false, error: "Cette connexion ne gère pas de DNS." };
  try {
    await opened.client.upsertRecord(domain, record);
  } catch (error) {
    return refusalOf(error);
  }
  return { ok: true, said: `Publié par ${opened.row.label}\u00a0: le DNS peut mettre quelques minutes à le montrer.` };
}

/** A domain's daily spam rate at Gmail, from a connected Postmaster Tools account. */
export async function reputationOf(services: Services, workspaceId: string, connectionId: string, domain: string, days: number): Promise<{ ok: true; days: DomainReputation[] } | { ok: false; error: string }> {
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.reputation) return { ok: false, error: "Cette connexion ne lit pas la réputation d’un domaine." };
  try {
    return { ok: true, days: await opened.client.reputation(domain, days) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Le service n’a pas répondu." };
  }
}

/** What a connected source (INSEE Sirene, INPI) knows about a company: a member's way to see it works. */
export async function factsOf(services: Services, workspaceId: string, connectionId: string, siren: string): Promise<{ ok: true; facts: CompanyFacts } | { ok: false; error: string }> {
  if (!/^\d{9}$/.test(siren)) return { ok: false, error: "Un SIREN compte 9 chiffres." };
  const opened = await openConnection(services, workspaceId, connectionId);
  if (!opened?.client.company) return { ok: false, error: "Cette connexion ne décrit pas d’entreprises." };
  try {
    const facts = await opened.client.company(siren);
    return facts ? { ok: true, facts } : { ok: false, error: `Cette source ne connaît pas le SIREN ${siren}.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Le service n’a pas répondu." };
  }
}
