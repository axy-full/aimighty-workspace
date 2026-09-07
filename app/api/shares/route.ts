import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { mintShare, listShares, revokeShare, shareLive, SHARE_DAYS, MAX_SHARE_DAYS } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** The production's client review links (brief 2.6). The token itself is shown once, at minting. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!ws || !projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  const shares = await listShares(ws.id, projectId);
  return NextResponse.json({ shares: shares.map((s) => ({ ...s, live: shareLive(s) })), days: SHARE_DAYS, maxDays: MAX_SHARE_DAYS });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (got.user.role !== "admin") return NextResponse.json({ error: "An admin makes a review link." }, { status: 403 });
  const ws = currentTenant()?.workspace;
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  if (!ws || !projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  const { share, token } = await mintShare({ workspaceId: ws.id, projectId, label: String(body.label ?? ""), days: Number(body.days) || SHARE_DAYS, by: got.user.name });
  return NextResponse.json({ share: { ...share, live: true }, url: `${new URL(req.url).origin}/review/${token}` }, { status: 201 });
});

export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (got.user.role !== "admin") return NextResponse.json({ error: "An admin revokes a review link." }, { status: 403 });
  const ws = currentTenant()?.workspace;
  const shareId = new URL(req.url).searchParams.get("id") ?? "";
  if (!ws || !shareId) return NextResponse.json({ error: "Which link?" }, { status: 400 });
  const gone = await revokeShare(ws.id, shareId);
  return NextResponse.json({ ok: gone });
});
