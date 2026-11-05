import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connectionsOf, connectorsOffered, type ConnectionView } from "@/application/connections";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { ConfirmButton, TryButton } from "@/components/try-button";
import { Card, Code, PrimaryButton, StatusDot } from "@/components/ui";
import { CONNECTOR_SETUP } from "@/domain/connector-setup";
import { CATEGORY_NAMES, CONNECTORS, connectorOf, type Capability, type Connector } from "@/domain/connectors";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { checkAction, disconnectAction, readNowAction, resumeAction, signInToProviderAction, testAlertAction, testEmailAction } from "../actions";
import { CompanyLookup } from "./company-lookup";
import { ConnectForm } from "./connect-form";

export function generateStaticParams() {
  return CONNECTORS.map((connector) => ({ kind: connector.kind }));
}

export async function generateMetadata({ params }: PageProps<"/connections/[kind]">): Promise<Metadata> {
  const { kind } = await params;
  return { title: connectorOf(kind)?.name ?? "Connexion" };
}

const when = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });

/** Where a capability is used from, when it isn't tried on this page. */
const USED_FROM: Partial<Record<Capability, { href: string; label: string }>> = {
  dns_records: { href: "/deliverability", label: "Vérifier et publier un domaine" },
  reputation: { href: "/deliverability", label: "Voir la réputation d’un domaine" },
  read_sheet: { href: "/lists", label: "Importer dans une liste" },
  push_contacts: { href: "/lists", label: "Envoyer des prospects" },
};

function Dates({ connection }: { connection: ConnectionView }) {
  const dates = [connection.checkedAt && `Vérifiée le ${when.format(connection.checkedAt)}`, connection.syncedAt && `Lue le ${when.format(connection.syncedAt)}`].filter(Boolean);
  return dates.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{dates.join(" · ")}</p>;
}

function Connection({ connection, connector }: { connection: ConnectionView; connector: Connector }) {
  const can = (capability: Capability) => (connector.capabilities as readonly Capability[]).includes(capability);
  const bound = <T,>(action: (kind: string, connectionId: string) => Promise<T>) => action.bind(null, connector.kind, connection.id);
  const links = connector.capabilities.flatMap((capability) => USED_FROM[capability as Capability] ?? []);
  return (
    <Card>
      <div className="flex min-w-0 items-center gap-3">
        <StatusDot status={connection.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{connection.label}</span>
      </div>
      <Dates connection={connection} />
      {connection.pausedReason && <p className="mt-3 text-sm text-ember">En pause. {connection.pausedReason}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {connection.pausedReason && <TryButton action={bound(resumeAction)} label="Reprendre les envois" busy="…" />}
        {can("send_email") && <TryButton action={bound(testEmailAction)} label="M’envoyer un email de test" busy="Envoi…" />}
        {can("notify") && <TryButton action={bound(testAlertAction)} label="Envoyer une alerte de test" busy="Envoi…" />}
        {(can("read_replies") || can("meetings")) && <TryButton action={bound(readNowAction)} label="Lire maintenant" busy="Lecture…" />}
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-accent">
            {link.label}
          </Link>
        ))}
        <TryButton action={bound(checkAction)} label="Vérifier" busy="Vérification…" />
        <ConfirmButton action={bound(disconnectAction)} label="Déconnecter" confirm="Confirmer : oublier ce compte et ses identifiants" />
      </div>
      {can("find_companies") && <CompanyLookup connectionId={connection.id} />}
      {connection.lastError && <p className="mt-3 text-sm text-ember">{connection.lastError}</p>}
      {connection.hookUrl && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">
            {connector.authorization.kind === "inbound" ? "Votre site poste" : `${connector.name} poste ici`} {connector.webhooks}, à cette adresse :
          </p>
          <div className="mt-2">
            <Code>{connection.hookUrl}</Code>
          </div>
        </div>
      )}
      {connection.signingSecret && (
        <div className="mt-4">
          <p className="text-sm text-muted-foreground">Chaque envoi est signé (en-tête Coldlyne-Signature) avec ce secret :</p>
          <div className="mt-2">
            <Code>{connection.signingSecret}</Code>
          </div>
        </div>
      )}
    </Card>
  );
}

function Authorize({ connector }: { connector: Connector }) {
  const { authorization } = connector;
  if (authorization.kind === "oauth") {
    return (
      <form action={signInToProviderAction.bind(null, connector.kind)}>
        <PrimaryButton type="submit">Se connecter avec {authorization.provider === "google" ? "Google" : "Microsoft"}</PrimaryButton>
      </form>
    );
  }
  if (authorization.kind === "fields") return <ConnectForm kind={connector.kind} fields={authorization.fields} />;
  return <ConnectForm kind={connector.kind} fields={[]} />;
}

async function Content({ params, searchParams }: Pick<PageProps<"/connections/[kind]">, "params" | "searchParams">) {
  const { kind } = await params;
  const services = appServices();
  const connector = connectorOf(kind);
  if (!connector) notFound();
  const { error } = await searchParams;
  const setup = CONNECTOR_SETUP[connector.kind];
  const seat = await currentSeat();
  const mine = (await connectionsOf(services, seat.workspaceId)).filter((connection) => connection.kind === connector.kind);
  // One already connected stays reachable, to disconnect it, even if the instance has since removed its app.
  const offered = connectorsOffered(services.settings).includes(connector);
  if (!offered && mine.length === 0) notFound();
  return (
    <>
      <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        <Link href="/connections" className="hover:text-foreground">
          {CATEGORY_NAMES[connector.category]}
        </Link>
      </p>
      <div className="mt-3">
        <PageHeading title={connector.name}>{connector.summary}</PageHeading>
      </div>
      {typeof error === "string" && <p className="mb-6 text-sm text-ember">{error}</p>}
      <div className="space-y-4">
        {mine.map((connection) => (
          <Connection key={connection.id} connection={connection} connector={connector} />
        ))}
        {offered && (connector.authorization.kind !== "inbound" || mine.length === 0) && (
        <Card>
          <h2 className="mb-4 font-semibold tracking-[-0.02em]">{mine.length > 0 ? "Connecter un autre compte" : "Connecter"}</h2>
          {setup && (
            <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              {setup.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          <Authorize connector={connector} />
          <p className="mt-5 text-xs text-muted-foreground">
            Données traitées : {connector.hosting === "EU" ? "Union européenne" : connector.hosting === "US" ? "États-Unis" : "Union européenne ou États-Unis, selon votre compte"}.{" "}
            {connector.docs && (
              <a href={connector.docs} target="_blank" rel="noreferrer" className="text-link hover:underline">
                Documentation du service
              </a>
            )}
          </p>
        </Card>
        )}
      </div>
    </>
  );
}

/** One service: the accounts connected, and how to connect another. */
export default function ConnectionPage({ params, searchParams }: PageProps<"/connections/[kind]">) {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
