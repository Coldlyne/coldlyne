import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connectionsOf, connectorsOffered, type ConnectionView } from "@/application/connections";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Eyebrow, Rows, StatusDot } from "@/components/ui";
import { CATEGORY_NAMES, type ConnectorCategory } from "@/domain/connectors";
import { currentSeat } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";

export const metadata: Metadata = { title: "Connexions" };

const CATEGORIES = Object.keys(CATEGORY_NAMES) as ConnectorCategory[];

/** The workspace's accounts first, what needs a look on top: this page is mostly opened to see how they are doing. */
function Mine({ connections }: { connections: ConnectionView[] }) {
  if (connections.length === 0) return null;
  const sorted = [...connections].sort((a, b) => Number(b.status === "failing" || Boolean(b.pausedReason)) - Number(a.status === "failing" || Boolean(a.pausedReason)));
  return (
    <section>
      <h2>
        <Eyebrow>Vos connexions</Eyebrow>
      </h2>
      <Rows className="mt-3">
        {sorted.map((connection) => (
          <li key={connection.id}>
            <Link href={`/connections/${connection.kind}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm transition-colors hover:bg-accent">
              <StatusDot status={connection.pausedReason ? "failing" : connection.status} />
              <span className="font-medium">{connection.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{connection.label}</span>
              {(connection.pausedReason ?? connection.lastError) && <span className="w-full text-xs text-ember">{connection.pausedReason ?? connection.lastError}</span>}
            </Link>
          </li>
        ))}
      </Rows>
    </section>
  );
}

async function Catalogue() {
  const seat = await currentSeat();
  const services = appServices();
  const connections = await connectionsOf(services, seat.workspaceId);
  const offered = connectorsOffered(services.settings);
  return (
    <div className="space-y-10">
      <Mine connections={connections} />
      {CATEGORIES.filter((category) => offered.some((connector) => connector.category === category)).map((category) => (
        <section key={category}>
          <h2>
            <Eyebrow>{CATEGORY_NAMES[category]}</Eyebrow>
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {offered.filter((connector) => connector.category === category).map((connector) => {
              const mine = connections.filter((connection) => connection.kind === connector.kind);
              return (
                <li key={connector.kind}>
                  <Link href={`/connections/${connector.kind}`} className="card-premium flex h-full flex-col rounded-2xl p-5 outline-none transition-colors hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span className="flex items-center gap-2 font-medium tracking-[-0.02em]">
                      {mine.length > 0 && <StatusDot status={mine.some((connection) => connection.status === "failing") ? "failing" : "connected"} />}
                      {connector.name}
                    </span>
                    <span className="mt-2 flex-1 text-sm text-muted-foreground">{connector.summary}</span>
                    {mine.length > 0 && <span className="mt-3 truncate font-mono text-[11px] text-muted-foreground">{mine.map((connection) => connection.label).join(", ")}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Every service a workspace can connect, by what it's for. */
export default function ConnectionsPage() {
  return (
    <Shell>
      <PageHeading title="Connexions">Ce que Coldlyne utilise pour agir et ce qu’il lit en retour. Les clés et les mots de passe se saisissent ici, jamais dans une conversation, et restent chiffrés.</PageHeading>
      <Suspense fallback={<Loading />}>
        <Catalogue />
      </Suspense>
    </Shell>
  );
}
