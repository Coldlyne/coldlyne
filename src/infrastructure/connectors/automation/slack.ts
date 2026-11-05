import type { Check, Notification } from "@/application/ports";
import type { Adapter, AdapterContext } from "../adapter";
import { ProviderError, requestText } from "../http";

/**
 * Slack, through an incoming webhook: a message in the channel the member chose.
 *
 * Docs: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 *       https://docs.slack.dev/messaging/formatting-message-text
 *
 * The check makes no call: Slack documents no dry run and no order of validation, and doesn't
 * give the HTTP codes of `no_text` or `no_service`, so a deliberately invalid payload can't be
 * trusted to tell a live webhook from a dead one. Only the address's shape is checked here, and
 * the first real message tells.
 */

const PROVIDER = "Slack";
const NOT_A_WEBHOOK = "Cette adresse n’est pas celle d’un webhook entrant Slack (https://hooks.slack.com/services/…).";

/** With `/services/` as in Slack's guide, or without as in its OAuth example; https to Slack only, as the address carries the secret. */
const WEBHOOK_URL = /^https:\/\/hooks\.slack\.com\/(services\/)?[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

/** Slack reads &, < and > as its own control characters unless they are escaped. */
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The message: the title in bold, the text, and a link to see it in Coldlyne when there is one. */
function slackMessage({ title, text, url }: Notification): string {
  const lines = [`*${escaped(title)}*`, escaped(text)];
  if (url) lines.push(`<${escaped(url)}|Voir dans Coldlyne>`);
  return lines.join("\n");
}

async function notify(context: AdapterContext, notification: Notification): Promise<void> {
  const url = context.fields.webhookUrl;
  if (!WEBHOOK_URL.test(url)) throw new ProviderError(PROVIDER, 400, NOT_A_WEBHOOK);
  await requestText(context.fetch, PROVIDER, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: slackMessage(notification) }) });
}

/** Checks the address's shape and posts nothing: see above. */
async function check(context: AdapterContext): Promise<Check> {
  if (!WEBHOOK_URL.test(context.fields.webhookUrl)) return { ok: false, detail: NOT_A_WEBHOOK };
  return { ok: true, detail: "vérifié au premier envoi", label: "Webhook Slack" };
}

export const slack: Adapter = (context) => ({
  check: () => check(context),
  notify: (notification) => notify(context, notification),
});
