import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { Suspense } from "react";
import { reputationOf } from "@/application/connection-use";
import { connectionsWith, type OpenedConnection } from "@/application/connections";
import type { Services } from "@/application/services";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { TryButton } from "@/components/try-button";
import { Card, Code, INLINE_FIELD, PrimaryButton, StatusDot } from "@/components/ui";
import { hostnameOf, isDomainName, type DnsRecord, type MailboxProvider, type ReportPart } from "@/domain/deliverability";
import { currentSeat } from "@/infrastructure/auth/session";
import { checkSendingDomain } from "@/infrastructure/dns/checks";
import { appServices } from "@/infrastructure/services";
import { publishAction } from "./actions";

export const metadata: Metadata = { title: "Délivrabilité" };

const PROVIDERS: { id: MailboxProvider; name: string }[] = [
  { id: "google", name: "Google Workspace" },
  { id: "microsoft", name: "Microsoft 365" },
  { id: "ovh", name: "OVHcloud" },
  { id: "infomaniak", name: "Infomaniak" },
];

const REPUTATION_DAYS = 30;

const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 2 });

function Part({ name, part }: { name: string; part: ReportPart }) {
  return (
    <Card>
      <h3 className="flex items-center gap-2 font-medium tracking-[-0.02em]">
        <StatusDot status={part.ok ? "connected" : "failing"} />
        {name}
      </h3>
      {part.found.map((found) => (
        <div key={found} className="mt-3">
          <Code>{found}</Code>
        </div>
      ))}
      {part.advice.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
          {part.advice.map((advice) => (
            <li key={advice}>{advice}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A record to publish, by hand or through each DNS the workspace connected. */
function Fix({ domain, record, dns }: { domain: string; record: DnsRecord; dns: OpenedConnection[] }) {
  return (
    <li className="space-y-2">
      <Code>{`${record.type}  ${record.name}  ${record.value}`}</Code>
      {dns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {dns.map((opened) => (
            <TryButton key={opened.row.id} action={publishAction.bind(null, opened.row.id, domain, record)} label={`Publier avec ${opened.row.label}`} busy="Publication…" />
          ))}
        </div>
      )}
    </li>
  );
}

async function Reputation({ services, workspaceId, domain, opened }: { services: Services; workspaceId: string; domain: string; opened: OpenedConnection }) {
  const read = await reputationOf(services, workspaceId, opened.row.id, domain, REPUTATION_DAYS);
  return (
    <Card>
      <h3 className="font-medium tracking-[-0.02em]">Taux de spam chez Gmail</h3>
      {!read.ok && <p className="mt-2 text-sm text-ember">{read.error}</p>}
      {read.ok && read.days.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Google ne rapporte rien sur ce domaine : il ne le fait qu’à partir de 50 destinataires Gmail par jour.</p>}
      {read.ok && read.days.length > 0 && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">
          {read.days.map((day) => (
            <li key={day.date}>
              {day.date} · {day.spamRate === null ? "pas de chiffre" : percent.format(day.spamRate)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const isProvider = (value: unknown): value is MailboxProvider => PROVIDERS.some((provider) => provider.id === value);

async function Content({ searchParams }: Pick<PageProps<"/deliverability">, "searchParams">) {
  const seat = await currentSeat();
  const services = appServices();
  const { domain: asked, provider: askedProvider, selectors } = await searchParams;
  const provider = isProvider(askedProvider) ? askedProvider : "google";
  const domain = typeof asked === "string" ? hostnameOf(asked) : "";
  const valid = isDomainName(domain);
  const given = typeof selectors === "string" ? selectors : "";
  const check = valid ? await checkSendingDomain(domain, provider, { dkimSelectors: given.split(/[\s,]+/).filter(Boolean) }) : null;
  const dns = check ? await connectionsWith(services, seat.workspaceId, "dns_records") : [];
  const postmaster = check ? await connectionsWith(services, seat.workspaceId, "reputation") : [];
  return (
    <div className="space-y-6">
      <Card>
        <Form action="/deliverability" className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm">
            Domaine d’envoi
            <input name="domain" required defaultValue={domain} placeholder="acme.fr" autoComplete="off" className={INLINE_FIELD} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Boîtes hébergées chez
            <select name="provider" defaultValue={provider} className={INLINE_FIELD}>
              {PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm">
            Sélecteurs DKIM (facultatif)
            <input name="selectors" defaultValue={given} placeholder="s1, s2" autoComplete="off" className={INLINE_FIELD} />
          </label>
          <PrimaryButton type="submit">Vérifier</PrimaryButton>
        </Form>
        {typeof asked === "string" && !valid && <p className="mt-3 text-sm text-ember">Ce n’est pas un nom de domaine : essayez acme.fr, sans https ni adresse.</p>}
      </Card>
      {check && (
        <>
          <p className="text-sm text-muted-foreground">{check.recommendation}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Part name="SPF" part={check.report.spf} />
            <Part name="DKIM" part={check.report.dkim} />
            <Part name="DMARC" part={check.report.dmarc} />
            <Part name="MX" part={check.report.mx} />
          </div>
          {check.fixes.length > 0 && (
            <Card>
              <h3 className="font-medium tracking-[-0.02em]">À publier sur {domain}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {dns.length > 0 ? "Publier remplace l’enregistrement de même type et de même nom." : "Copiez-les chez votre hébergeur DNS, ou "}
                {dns.length === 0 && (
                  <Link href="/connections" className="text-link hover:underline">
                    connectez Vercel, Cloudflare ou OVHcloud
                  </Link>
                )}
                {dns.length === 0 && " pour les publier d’ici."}
              </p>
              <ul className="mt-4 space-y-4">
                {check.fixes.map((record) => (
                  <Fix key={`${record.type}-${record.name}-${record.value}`} domain={domain} record={record} dns={dns} />
                ))}
              </ul>
            </Card>
          )}
          {postmaster.map((opened) => (
            <Reputation key={opened.row.id} services={services} workspaceId={seat.workspaceId} domain={domain} opened={opened} />
          ))}
        </>
      )}
    </div>
  );
}

/** Whether a sending domain is ready, what to publish, and how Gmail sees it: what an assistant can also do through its tools. */
export default function DeliverabilityPage({ searchParams }: PageProps<"/deliverability">) {
  return (
    <Shell>
      <PageHeading title="Délivrabilité">Ce que les serveurs de messagerie lisent de votre domaine avant d’accepter vos emails, et ce qu’il reste à publier.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
