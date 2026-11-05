import Link from "next/link";
import { Suspense } from "react";
import { connectionsOf } from "@/application/connections";
import { messagesToReview } from "@/application/messages";
import { tasksOf } from "@/application/tasks";
import { conversationsOf } from "@/application/threads";
import { Loading, PageHeading, Shell } from "@/components/shell";
import { Card, Code, StatusDot } from "@/components/ui";
import { mcpResource } from "@/infrastructure/auth/server";
import { currentSeat } from "@/infrastructure/auth/session";
import { env } from "@/infrastructure/env";
import { appServices } from "@/infrastructure/services";

/** How each assistant adds a remote MCP server, in its own words. Their menus move: the address is what counts. */
const ASSISTANTS = [
  { name: "Claude", steps: "Réglages → Connecteurs → Ajouter un connecteur personnalisé, puis collez l’adresse." },
  { name: "ChatGPT", steps: "Réglages → Applications et connecteurs → Paramètres avancés\u00a0: activez le mode développeur, créez un connecteur et collez l’adresse. Selon votre offre, il peut être réservé aux administrateurs ou limité." },
  { name: "Le Chat (Mistral)", steps: "Intelligence → Connecteurs → Ajouter un connecteur → MCP personnalisé, puis collez l’adresse. Il faut être administrateur." },
];

function Figure({ href, count, label }: { href: string; count: number; label: string }) {
  return (
    <Link href={href} className="card-sheen rounded-2xl border bg-card p-5 transition-colors hover:border-foreground/20">
      <p className="text-3xl font-semibold tracking-[-0.04em]">{count}</p>
      <p className="mt-1 text-sm text-muted-foreground">{label}</p>
    </Link>
  );
}

async function Home() {
  const seat = await currentSeat();
  const connections = await connectionsOf(appServices(), seat.workspaceId);
  const address = mcpResource(env());
  const services = appServices();
  const [tasks, approvals, failed, conversations] = await Promise.all([tasksOf(services.db, seat.workspaceId, seat.userId), messagesToReview(services.db, seat.workspaceId, "awaiting_approval"), messagesToReview(services.db, seat.workspaceId, "failed"), conversationsOf(services.db, seat.workspaceId)]);
  const unread = conversations.filter((conversation) => !conversation.interest).length;
  return (
    <>
      <PageHeading title={seat.workspaceName}>Prospectez en demandant à votre assistant : il cherche, rédige, envoie et suit les réponses. Vous fixez les limites, Coldlyne les tient.</PageHeading>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Figure href="/today" count={tasks.length} label="à faire aujourd’hui" />
        <Figure href="/sequences" count={approvals.length + failed.length} label="messages à approuver ou corriger" />
        <Figure href="/replies" count={unread} label="réponses à lire" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="font-semibold tracking-[-0.02em]">Connectez votre assistant</h2>
          <p className="mt-2 text-sm text-muted-foreground">L’adresse du serveur MCP de Coldlyne :</p>
          <div className="mt-3">
            <Code>{address}</Code>
          </div>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {ASSISTANTS.map((assistant) => (
              <li key={assistant.name}>
                <span className="font-medium text-foreground">{assistant.name}.</span> {assistant.steps}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">Claude Code :</p>
          <div className="mt-2">
            <Code>claude mcp add --transport http coldlyne {address}</Code>
          </div>
        </Card>
        <Card>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-semibold tracking-[-0.02em]">Vos connexions</h2>
            <Link href="/connections" className="text-sm text-link hover:underline">
              Tout voir
            </Link>
          </div>
          {connections.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Rien encore. Commencez par une boîte mail : c’est elle qui envoie.</p>
          ) : (
            <ul className="mt-4 space-y-2.5 text-sm">
              {connections.map((connection) => (
                <li key={connection.id} className="flex min-w-0 items-center gap-2.5">
                  <StatusDot status={connection.status} />
                  <span className="truncate">{connection.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{connection.name}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

/** What a member sees first: how to connect their assistant, and how their connections are doing. */
export default function HomePage() {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Home />
      </Suspense>
    </Shell>
  );
}
