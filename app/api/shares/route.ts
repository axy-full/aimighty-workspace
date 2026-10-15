import { NextResponse } from "next/server";
import { requireSession, requireUser, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { mintShare, listShares, revokeShare, shareLive, shareProject, SHARE_DAYS, MAX_SHARE_DAYS } from "@/lib/shares";
import { clientLinkVerdict, mayReachProject, ownsDraftProject } from "@/lib/draftProject";
import { db, ready } from "@/lib/db";
import { linkOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";

/** The production's client review links (brief 2.6). The token itself is shown once, at minting. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!ws || !projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  /* A private board's links are for those who may reach the board: anyone else is answered as for a production with none. */
  const shares = (await mayReachProject(got.user, projectId, "read")) ? await listShares(ws.id, projectId) : [];
  return NextResponse.json({ shares: shares.map((s) => ({ ...s, live: shareLive(s) })), days: SHARE_DAYS, maxDays: MAX_SHARE_DAYS });
});

/* Making or withdrawing a link that opens a production to someone outside the workspace is a person's act:
   an API or MCP token, even an admin's, is refused (requireSession). */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireSession();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  if (!ws || !projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  /* A link opens a production of this workspace. A private board's owner makes its links, admin or not; anyone else is answered as a production that is not saved is (an admin too), before any role check; everything else is an admin's, as before. */
  await ready();
  const notSaved = () => NextResponse.json({ error: "Save the production first; a link opens a saved production." }, { status: 404 });
  const known = (await db().execute({ sql: "SELECT 1 FROM projects WHERE id=? LIMIT 1", args: [projectId] })).rows.length > 0;
  if (!known) return notSaved();
  const who = await clientLinkVerdict(got.user, projectId);
  if (who === "none") return notSaved();
  if (who === "admin" && got.user.role !== "admin") return NextResponse.json({ error: "An admin makes a review link." }, { status: 403 });
  const { share, token } = await mintShare({ workspaceId: ws.id, projectId, label: String(body.label ?? ""), days: Number(body.days) || SHARE_DAYS, by: got.user.name, actorId: got.user.id });
  return NextResponse.json({ share: { ...share, live: true }, url: `${linkOrigin(req)}/review/${token}` }, { status: 201 });
});

export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireSession();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  const shareId = new URL(req.url).searchParams.get("id") ?? "";
  if (!ws || !shareId) return NextResponse.json({ error: "Which link?" }, { status: 400 });
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(shareId))return NextResponse.json({error:"Invalid review link."},{status:400});
  /* An admin revokes any link of this workspace; a private board's owner revokes its links too. Anyone else gets the same answer whether or not the link exists. */
  const opens = got.user.role === "admin" ? null : await shareProject(ws.id, shareId);
  if (got.user.role !== "admin" && !(opens !== null && (await ownsDraftProject(got.user.id, opens)))) return NextResponse.json({ error: "An admin revokes a review link." }, { status: 403 });
  const gone = await revokeShare(ws.id, shareId, got.user.id);
  return NextResponse.json({ ok: gone });
});
