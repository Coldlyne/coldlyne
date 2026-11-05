import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { invitationPath, seeInvitation } from "@/application/invitations";
import { Logo } from "@/components/logo";
import { Loading } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Card, PrimaryButton } from "@/components/ui";
import { INVITATION_REFUSALS, type InvitationRefusal } from "@/domain/team";
import { currentMember } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { joinAction } from "./actions";

// The link is the invitation: it mustn't follow someone to the next site they visit.
export const metadata: Metadata = { title: "Rejoindre un espace", robots: { index: false }, referrer: "no-referrer" };

/** Why this link doesn't let them in, naming nobody; with the wrong account, a way to change it and come back. */
function Refused({ refusal, back }: { refusal: InvitationRefusal; back: string }) {
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">Cette invitation ne vous ouvre pas d’espace</h1>
      <p className="mt-2 text-sm text-muted-foreground">{INVITATION_REFUSALS[refusal]}</p>
      <div className="mt-5 text-sm text-muted-foreground">
        {refusal === "other_address" ? (
          <SignOutButton to={`/sign-in?${new URLSearchParams({ next: back })}`} />
        ) : (
          <Link href="/" className="text-link hover:underline">
            Retour à l’accueil
          </Link>
        )}
      </div>
    </Card>
  );
}

/** Asks first rather than joining on opening the link: mail scanners open links too, and nothing changes on a GET. */
async function Invitation({ params }: Pick<PageProps<"/join/[token]">, "params">) {
  const { token } = await params;
  const back = invitationPath(token);
  const member = await currentMember();
  // Nobody signed in: no database read, and nothing said about the invitation until they are.
  if (!member) redirect(`/sign-in?${new URLSearchParams({ next: back })}`);
  const { db, now } = appServices();
  const seen = await seeInvitation(db, member.userId, token, now());
  if (seen.status !== "open") return <Refused refusal={seen.status} back={back} />;
  return (
    <Card className="mt-8 w-full max-w-md">
      <h1 className="text-xl font-semibold tracking-[-0.03em]">Rejoindre {seen.workspaceName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Vous verrez ses listes, ses séquences et ses réponses, et votre assistant pourra y travailler avec vous.</p>
      <form action={joinAction.bind(null, token)} className="mt-5">
        <PrimaryButton type="submit">Rejoindre l’espace</PrimaryButton>
      </form>
    </Card>
  );
}

/** Where an invitation's link leads. */
export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <main className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-96 bg-glow" />
      <Logo id="join" />
      <Suspense fallback={<Loading />}>
        <Invitation params={params} />
      </Suspense>
    </main>
  );
}
