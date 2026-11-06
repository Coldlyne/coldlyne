import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { invitationPath, seeInvitation } from "@/application/invitations";
import { AuthCard, AuthFrame, AuthTitle } from "@/components/auth-frame";
import { Loading } from "@/components/shell";
import { SignOutButton } from "@/components/sign-out-button";
import { PrimaryButton } from "@/components/ui";
import { INVITATION_REFUSALS, type InvitationRefusal } from "@/domain/team";
import { currentMember } from "@/infrastructure/auth/session";
import { appServices } from "@/infrastructure/services";
import { joinAction } from "./actions";

// The link is the invitation: it mustn't follow someone to the next site they visit.
export const metadata: Metadata = { title: "Rejoindre un espace", robots: { index: false }, referrer: "no-referrer" };

/** Why this link doesn't let them in, naming nobody; with the wrong account, a way to change it and come back. */
function Refused({ refusal, back }: { refusal: InvitationRefusal; back: string }) {
  return (
    <AuthCard>
      <AuthTitle>Cette invitation ne vous ouvre pas d’espace</AuthTitle>
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
    </AuthCard>
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
    <AuthCard>
      <AuthTitle>Rejoindre {seen.workspaceName}</AuthTitle>
      <p className="mt-2 text-sm text-muted-foreground">Vous verrez ses listes, ses séquences et ses réponses, et votre assistant pourra y travailler avec vous.</p>
      <form action={joinAction.bind(null, token)} className="mt-5">
        <PrimaryButton type="submit">Rejoindre l’espace</PrimaryButton>
      </form>
    </AuthCard>
  );
}

/** Where an invitation's link leads. */
export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <AuthFrame id="join">
      <Suspense fallback={<Loading />}>
        <Invitation params={params} />
      </Suspense>
    </AuthFrame>
  );
}
