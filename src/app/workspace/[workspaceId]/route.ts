import { NextResponse } from "next/server";
import { workspacesOf } from "@/application/workspaces";
import { safeNext } from "@/domain/safe-next";
import { currentMember, enterWorkspace } from "@/infrastructure/auth/session";
import { db } from "@/infrastructure/db/client";

/**
 * Where an assistant's link to a page goes through when its member has several workspaces: the
 * browser enters the workspace the assistant was working in, then opens the page. Someone not in that
 * workspace simply lands on the page in their own, and learns nothing of it.
 */
export async function GET(request: Request, { params }: RouteContext<"/workspace/[workspaceId]">) {
  const { workspaceId } = await params;
  const url = new URL(request.url);
  const member = await currentMember();
  if (!member) return NextResponse.redirect(new URL(`/sign-in?${new URLSearchParams({ next: `${url.pathname}${url.search}` })}`, request.url));
  if ((await workspacesOf(db(), member.userId)).some(({ id }) => id === workspaceId)) await enterWorkspace(workspaceId);
  return NextResponse.redirect(new URL(safeNext(url.searchParams.get("next")), request.url));
}
