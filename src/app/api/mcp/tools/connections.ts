import { z } from "zod";
import { sendTestAlert } from "@/application/connection-use";
import { checkConnection, connectionsOf, connectorsOffered, disconnect } from "@/application/connections";
import { sendTestEmail } from "@/application/test-email";
import { CATEGORY_NAMES } from "@/domain/connectors";
import { answer, appUrl, refusal, type ToolRegistrar } from "./tool";

const categories = Object.keys(CATEGORY_NAMES) as [keyof typeof CATEGORY_NAMES, ...(keyof typeof CATEGORY_NAMES)[]];

/** The services a workspace can connect, which it has, and their health. */
export const connectionTools: ToolRegistrar = (server, context) => {
  server.registerTool(
    "list_connectors",
    {
      title: "Services you can connect",
      description:
        "Every service Coldlyne can connect (mailboxes, SMS, letters, telephony, WhatsApp Business, calendars, CRMs, alerts, DNS, data sources), what each lets you do, and which this workspace already connected. Use it to see what's possible before planning a campaign.",
      inputSchema: z.object({ category: z.enum(categories).optional().describe("Only this category.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ category }) => {
      const connected = await connectionsOf(context.services, context.workspaceId);
      const connectors = connectorsOffered(context.services.settings).filter((connector) => !category || connector.category === category).map((connector) => ({
        kind: connector.kind,
        name: connector.name,
        category: CATEGORY_NAMES[connector.category],
        summary: connector.summary,
        capabilities: connector.capabilities,
        hosting: connector.hosting,
        connected: connected.filter((item) => item.kind === connector.kind).map(({ id, label, status, lastError }) => ({ id, label, status, lastError })),
      }));
      return answer({ connectors });
    },
  );

  server.registerTool(
    "list_connections",
    {
      title: "This workspace's connections",
      description: "The services this workspace connected, with their health (connected or failing, and why) and the address each one posts its replies or outcomes to.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => answer({ connections: await connectionsOf(context.services, context.workspaceId) }),
  );

  server.registerTool(
    "connect_service",
    {
      title: "Connect a service",
      description:
        "Gives the link where a member connects a service. Keys, tokens and passwords are typed into Coldlyne's own page, never into this conversation: never ask the user for them here. Mailboxes and calendars connect by signing in to Google or Microsoft from that page.",
      inputSchema: z.object({ kind: z.string().describe("The connector's kind, from list_connectors (gmail, smtp, brevo_sms, hubspot…).") }),
      annotations: { readOnlyHint: true },
    },
    async ({ kind }) => {
      const connector = connectorsOffered(context.services.settings).find((offered) => offered.kind === kind);
      if (!connector) return refusal(`No connector "${kind}" on this instance. Call list_connectors for the kinds.`);
      const how = connector.authorization.kind === "oauth" ? "The member signs in to the provider from that page." : connector.authorization.kind === "inbound" ? "Nothing to type: the page gives the signed address the site posts to." : "The member pastes what the provider's console gives them on that page.";
      return answer({ kind, name: connector.name, url: appUrl(context, `/connections/${kind}`), docs: connector.docs }, `Send the member to this page to connect ${connector.name}. ${how}`);
    },
  );

  server.registerTool(
    "check_connection",
    {
      title: "Check a connection",
      description: "Asks the service again whether a connection still works (a refused key, an expired sign-in…), and records the answer.",
      inputSchema: z.object({ connectionId: z.uuid() }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ connectionId }) => {
      const checked = await checkConnection(context.services, context.workspaceId, connectionId);
      return checked ? answer({ connection: checked }) : refusal("No such connection in this workspace.");
    },
  );

  server.registerTool(
    "send_test_email",
    {
      title: "Send a test email to yourself",
      description: "Sends a short test from a connected mailbox to the signed-in member's own address, to prove the mailbox can send. It can't go to anyone else: prospects are reached through sequences, with their caps and legal footer.",
      inputSchema: z.object({ connectionId: z.uuid() }),
      annotations: { openWorldHint: true },
    },
    async ({ connectionId }) => {
      const sent = await sendTestEmail(context.services, context.workspaceId, context.userId, connectionId);
      return sent.ok ? answer({ sentTo: sent.to, from: sent.from }) : refusal(sent.error);
    },
  );

  server.registerTool(
    "send_test_alert",
    {
      title: "Send a test alert",
      description: "Sends a test message through a connected alert (a Slack channel, an outgoing webhook), to prove it arrives.",
      inputSchema: z.object({ connectionId: z.uuid() }),
      annotations: { openWorldHint: true },
    },
    async ({ connectionId }) => {
      const sent = await sendTestAlert(context.services, context.workspaceId, connectionId);
      return sent.ok ? answer({ said: sent.said }) : refusal(sent.error);
    },
  );

  server.registerTool(
    "disconnect_service",
    {
      title: "Disconnect a service",
      description: "Forgets a connection and its credentials. What it brought in (replies, outcomes) stays. Confirm with the member first.",
      inputSchema: z.object({ connectionId: z.uuid() }),
      annotations: { destructiveHint: true },
    },
    async ({ connectionId }) => ((await disconnect(context.services, context.workspaceId, connectionId)) ? answer({ disconnected: connectionId }) : refusal("No such connection in this workspace.")),
  );
};
