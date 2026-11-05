import type { Check, Signal } from "@/application/ports";
import type { Adapter } from "../adapter";
import { checked } from "../checked";
import { ProviderError } from "../http";
import { type OvhClient, ovhClient, readEach, segment } from "../ovh";
import { optOutSignal, readDate, replySignal } from "./signals";
import { creditsLeft, withoutStopMention } from "./text";

/**
 * OVHcloud's SMS. Prospecting is advertising, so OVH must add its own STOP (`noStopClause` false)
 * and its terms forbid writing one by hand. A named sender can't be answered: its replies never
 * reach `/incoming`, and a STOP sent to OVH's short code lands on the account's blocklist, so both
 * are read here. Nothing is posted back to Coldlyne.
 *
 * Docs: https://eu.api.ovh.com/1.0/sms.json
 *       https://docs.ovhcloud.com/en/guides/web-cloud/messaging/sms/send-sms-api-nodejs
 *       https://docs.ovhcloud.com/en/guides/web-cloud/messaging/sms/send-sms-control-panel
 *       https://docs.ovhcloud.com/fr/guides/web-cloud/messaging/sms/sms-senders
 *       https://docs.ovhcloud.com/en/guides/web-cloud/messaging/sms/faq-sms
 *       https://community.ovhcloud.com/t/sms-clause-stop/38689 (OVH staff, on the STOP clause)
 */

const PROVIDER = "OVHcloud";

interface OvhIncoming {
  id: number;
  creationDatetime?: string;
  message?: string;
  sender?: string;
}

interface OvhBlocked {
  number: string;
  dateCreation?: string;
}

/** Why a sender can't send yet, by its status. */
const SENDER_PROBLEM: Record<string, string> = {
  waitingValidation: "attend encore la validation d’OVHcloud",
  refused: "a été refusé par OVHcloud",
  disable: "est désactivé",
};

export const ovhSms: Adapter = (context) => {
  const ovh = ovhClient(context);
  const account = `/sms/${segment(context.fields.serviceName)}`;
  const { sender } = context.fields;
  return {
    check: () => checked(PROVIDER, () => checkAccount(ovh, account, sender)),
    async sendSms({ to, text }) {
      const body = { message: withoutStopMention(text), receivers: [to], sender, noStopClause: false, senderForResponse: false };
      const report = await ovh.call<{ ids?: number[] }>("POST", `${account}/jobs`, body);
      const id = report.ids?.[0];
      if (id === undefined) throw new ProviderError(PROVIDER, 400, `OVHcloud n’a pas accepté le numéro ${to}.`);
      return { externalId: String(id) };
    },
    async signalsSince(since) {
      const [replies, stops] = await Promise.all([repliesSince(ovh, account, since, context.now()), stopsSince(ovh, account, since, context.now())]);
      return [...replies, ...stops].sort((a, b) => a.at.getTime() - b.at.getTime());
    },
  };
};

async function checkAccount(ovh: OvhClient, account: string, sender: string): Promise<Check> {
  const { creditsLeft: credits, name } = await ovh.call<{ creditsLeft?: number; name?: string }>("GET", account);
  const problem = await senderProblem(ovh, account, sender);
  if (problem) return { ok: false, label: name, detail: `L’expéditeur ${sender} ${problem}.` };
  return { ok: true, label: name, detail: creditsLeft(credits ?? 0) };
}

/** A sender awaiting validation can't send, which is better said now than at the first SMS. */
async function senderProblem(ovh: OvhClient, account: string, sender: string): Promise<string | null> {
  try {
    const { status } = await ovh.call<{ status?: string }>("GET", `${account}/senders/${segment(sender)}`);
    return status === undefined ? null : (SENDER_PROBLEM[status] ?? null);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return "n’existe pas sur ce compte";
    throw error;
  }
}

async function repliesSince(ovh: OvhClient, account: string, since: Date, now: Date): Promise<Signal[]> {
  const ids = await ovh.call<number[]>("GET", `${account}/incoming?${new URLSearchParams({ "creationDatetime.from": since.toISOString() })}`);
  const replies = await readEach(ids, (id) => ovh.call<OvhIncoming>("GET", `${account}/incoming/${id}`));
  return replies.flatMap((reply) => (reply.sender ? [replySignal({ externalId: String(reply.id), from: reply.sender, text: reply.message ?? "", at: readDate(reply.creationDatetime, now) })] : []));
}

/** The blocklist can't be filtered by date, so each entry is read to see whether it is new. */
async function stopsSince(ovh: OvhClient, account: string, since: Date, now: Date): Promise<Signal[]> {
  const numbers = await ovh.call<string[]>("GET", `${account}/blacklists`);
  const blocked = await readEach(numbers, (number) => ovh.call<OvhBlocked>("GET", `${account}/blacklists/${segment(number)}`));
  return blocked.map((entry) => optOutSignal({ from: entry.number, at: readDate(entry.dateCreation, now) })).filter((stop) => stop.at >= since);
}
