import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { unsubscribeSubject } from "@/application/unsubscribe";
import { AuthFrame } from "@/components/auth-frame";
import { PrimaryButton } from "@/components/ui";
import { appServices } from "@/infrastructure/services";
import { confirmUnsubscribe } from "./actions";

export const metadata: Metadata = { title: "Ne plus recevoir de messages", robots: { index: false } };

async function Content({ params, searchParams }: Pick<PageProps<"/u/[token]">, "params" | "searchParams">) {
  await connection();
  const { token } = await params;
  const { done } = await searchParams;
  const subject = await unsubscribeSubject(appServices(), token);
  if (!subject) return <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">Ce lien n’est pas valable.</p>;
  if (done) return <p className="mt-8 max-w-sm text-center text-sm">C’est fait&nbsp;: {subject.sender} ne vous écrira plus à {subject.address}, sur aucun canal.</p>;
  return (
    <>
      <p className="mt-8 max-w-sm text-center text-sm text-muted-foreground">
        {subject.sender} ne vous écrira plus à {subject.address}, sur aucun canal.
      </p>
      {/* A button rather than the link itself: mail scanners open links, and must not unsubscribe anyone. */}
      <form action={confirmUnsubscribe.bind(null, token)} className="mt-6">
        <PrimaryButton type="submit">Ne plus recevoir de messages</PrimaryButton>
      </form>
    </>
  );
}

/** The way out every message carries: no account needed. */
export default function UnsubscribePage({ params, searchParams }: PageProps<"/u/[token]">) {
  return (
    <AuthFrame id="unsubscribe" horizon={false}>
      <Suspense>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </AuthFrame>
  );
}
