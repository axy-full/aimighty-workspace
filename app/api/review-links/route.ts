import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { db, ready } from "@/lib/db";
import { listShares, revokeShare, shareLive, SHARE_DAYS } from "@/lib/shares";
import { clientResponses, mintReviewLink, reviewLinksReady, scopeOf } from "@/lib/security/review-link";
import { linkOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/**
 * Crew review's client links (Gaps A, "Copy client link"): one production's review set, for a client who does not
 * sign in. Built on the existing review links (lib/shares.ts), marked as opening the review set
 * (lib/security/review-link.ts).
 *
 * People only, every way: an API or MCP token can neither list, make nor withdraw a link that opens a production to
 * someone outside the workspace. Making and withdrawing one is an owner's or admin's, as for every review link.
 * The secret is in the reply to the person who made it, once; it is stored only as a hash.
 */
async function production(projectId: string | null): Promise<string | null> {
  if (!projectId || !ID.test(projectId)) return null;
  await ready();
  const rs = await db().execute({ sql: `SELECT id FROM projects WHERE id = ? LIMIT 1`, args: [projectId] });
  return rs.rows.length ? projectId : null;
}

export const GET = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const projectId = await production(new URL(req.url).searchParams.get("projectId"));
  if (!projectId) return Response.json({ error: "Save the production first; a client link opens a saved production." }, { status: 404, headers });
  await reviewLinksReady();
  const all = await listShares(requireTenant().id, projectId);
  const mine = [];
  for (const s of all) if ((await scopeOf(s.id)) === "review") mine.push(s);
  const said = await clientResponses(projectId, mine.map((s) => s.id));
  const admin = got.user.role === "admin";
  return Response.json({
    canManage: admin,
    days: SHARE_DAYS,
    links: mine.map((s) => ({ id: s.id, live: shareLive(s), createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt })),
    said,
  }, { headers });
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  if (got.user.role !== "admin") return Response.json({ error: "An owner or admin makes a client link." }, { status: 403, headers });
  const body = await req.json().catch(() => ({}));
  const projectId = await production(typeof body?.projectId === "string" ? body.projectId : null);
  if (!projectId) return Response.json({ error: "Save the production first; a client link opens a saved production." }, { status: 404, headers });
  const { share, token } = await mintReviewLink({ workspaceId: requireTenant().id, projectId, days: SHARE_DAYS, by: got.user.name, actorId: got.user.id });
  return Response.json({
    link: { id: share.id, live: true, createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: null },
    url: `${linkOrigin(req)}/review/${token}`,
  }, { status: 201, headers });
}, { requireRequestScope: true });

export const DELETE = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  if (got.user.role !== "admin") return Response.json({ error: "An owner or admin withdraws a client link." }, { status: 403, headers });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID.test(id)) return Response.json({ error: "Which link?" }, { status: 400, headers });
  /* Scoped to this workspace in the platform database: another workspace's link id changes nothing. */
  return Response.json({ ok: await revokeShare(requireTenant().id, id, got.user.id) }, { headers });
}, { requireRequestScope: true });
