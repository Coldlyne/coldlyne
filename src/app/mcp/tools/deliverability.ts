import { z } from "zod";
import { publishRecord, reputationOf } from "@/application/connection-use";
import { checkSendingDomain } from "@/infrastructure/dns/checks";
import { answer, refusal, type ToolRegistrar } from "./tool";

const PROVIDERS = ["google", "microsoft", "ovh", "infomaniak"] as const;

/** Whether a sending domain will land in inboxes, and setting it up where the workspace connected its DNS. */
export const deliverabilityTools: ToolRegistrar = (server, context) => {
  const { services, workspaceId } = context;

  server.registerTool(
    "check_sending_domain",
    {
      title: "Check a sending domain",
      description: "Reads a domain's SPF, DKIM, DMARC and MX from public DNS for a mailbox provider, says what's wrong in plain words, and lists the records to publish. Needs no connection. OVHcloud and Infomaniak have no common DKIM selector: pass the ones from their console.",
      inputSchema: z.object({ domain: z.string().min(3), provider: z.enum(PROVIDERS), dkimSelectors: z.array(z.string()).optional(), dmarcReports: z.email().optional().describe("A mailbox for DMARC's reports, if the member has one.") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ domain, provider, dkimSelectors, dmarcReports }) => answer({ ...(await checkSendingDomain(domain, provider, { dkimSelectors, dmarcReports })) }),
  );

  server.registerTool(
    "publish_dns_record",
    {
      title: "Publish a DNS record",
      description: "Adds a record to a domain, or replaces the one of the same type and name, through a connected DNS (Vercel, Cloudflare, OVHcloud). Publish what check_sending_domain lists. Show the member the record and get their agreement first: this changes their live DNS.",
      inputSchema: z.object({ connectionId: z.uuid(), domain: z.string().min(3), type: z.enum(["TXT", "CNAME", "MX"]), name: z.string().min(1).describe('Relative to the domain: "@", "_dmarc", "s1._domainkey".'), value: z.string().min(1).describe('An MX value is written "10 mx.host".') }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ connectionId, domain, type, name, value }) => {
      const published = await publishRecord(services, workspaceId, connectionId, domain, { type, name, value });
      return published.ok ? answer({ published: { domain, type, name, value } }) : refusal(published.error);
    },
  );

  server.registerTool(
    "domain_reputation",
    {
      title: "A domain's reputation at Gmail",
      description: "The daily rate of mail marked as spam by Gmail users, from a connected Google Postmaster Tools account. Google only reports on domains sending to at least 50 users a day. Above 0.3% (0.003) is the danger line.",
      inputSchema: z.object({ connectionId: z.uuid(), domain: z.string().min(3), days: z.number().int().min(1).max(120).default(30) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ connectionId, domain, days }) => {
      const read = await reputationOf(services, workspaceId, connectionId, domain, days);
      return read.ok ? answer({ days: read.days }) : refusal(read.error);
    },
  );
};
