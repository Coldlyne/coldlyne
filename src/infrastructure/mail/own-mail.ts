import type { Env } from "../env";
import { bearerJson, requestJson } from "../connectors/http";

/**
 * Coldlyne's own mail to its members, through Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Never prospecting: Resend's terms forbid cold email, and a workspace's messages leave from its
 * own mailboxes. An instance without a key simply sends none of its own.
 */
export async function sendOwnMail(settings: Pick<Env, "RESEND_API_KEY" | "COLDLYNE_MAIL_FROM">, fetchUrl: typeof fetch, mail: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!settings.RESEND_API_KEY) return false;
  await requestJson(fetchUrl, "Resend", "https://api.resend.com/emails", {
    method: "POST",
    headers: bearerJson(settings.RESEND_API_KEY),
    body: JSON.stringify({ from: settings.COLDLYNE_MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  return true;
}
