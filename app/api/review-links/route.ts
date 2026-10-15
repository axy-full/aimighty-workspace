import { clientLinkVerdict, mayReachProject, ownsDraftProject } from "@/lib/draftProject";
import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { db, ready } from "@/lib/db";
import { listShares, revokeShare, shareLive, shareProject, SHARE_DAYS } from "@/lib/shares";
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
 * someone outside the workspace. An admin makes and withdraws one, as for every review link; the owner of a private board also makes (and withdraws) its links, admin or not.
 * The secret is in the reply to the person who made it, once; it is stored only as a hash.
 */
/** Whether the person owns the private board a link of this workspace opens. */
async function ownsShareProject(userId: string, shareId: string): Promise<boolean> {
  const projectId = await shareProject(requireTenant().id, shareId);
  return projectId !== null && (await ownsDraftProject(userId, projectId));
}
async function production(projectId: string | null, person: { id: string }, access: "read" | "write"): Promise<string | null> {
  if (!projectId || !ID.test(projectId)) return null;
  await ready();
  const rs = await db().execute({ sql: `SELECT id FROM projects WHERE id = ? LIMIT 1`, args: [projectId] });
  /* A private board is its owner's, and a shared one a teammate's to look at (lib/draftProject.ts): asked always, and refused as a production that is not saved is. */
  const reach = await mayReachProject(person, projectId, access);
  return rs.rows.length && reach ? projectId : null;
}

export const GET = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const projectId = await production(new URL(req.url).searchParams.get("projectId"), got.user, "read");
  if (!projectId) return Response.json({ error: "Save the production first; a client link opens a saved production." }, { status: 404, headers });
  await reviewLinksReady();
  const all = await listShares(requireTenant().id, projectId);
  const mine = [];
  for (const s of all) if ((await scopeOf(s.id)) === "review") mine.push(s);
  const said = await clientResponses(projectId, mine.map((s) => s.id));
  const admin = got.user.role === "admin" || (await ownsDraftProject(got.user.id, projectId));
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
  const body = await req.json().catch(() => ({}));
  const asked = typeof body?.projectId === "string" ? body.projectId : null;
  const notSaved = () => Response.json({ error: "Save the production first; a client link opens a saved production." }, { status: 404, headers });
  if (!asked || !ID.test(asked)) return notSaved();
  await ready();
  if (!(await db().execute({ sql: `SELECT id FROM projects WHERE id = ? LIMIT 1`, args: [asked] })).rows.length) return notSaved();
  /* A private board's owner makes its links, admin or not; anyone else is answered as a production that is not saved is (an admin too), before any role check, so nothing says which boards exist. Everything else is an admin's. */
  const who = await clientLinkVerdict(got.user, asked);
  if (who === "none") return notSaved();
  if (who === "admin") {
    if (got.user.role !== "admin") return Response.json({ error: "An owner or admin makes a client link." }, { status: 403, headers });
    if (!(await production(asked, got.user, "write"))) return notSaved();
  }
  const projectId = asked;
  const { share, token } = await mintReviewLink({ workspaceId: requireTenant().id, projectId, days: SHARE_DAYS, by: got.user.name, actorId: got.user.id });
  return Response.json({
    link: { id: share.id, live: true, createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: null },
    url: `${linkOrigin(req)}/review/${token}`,
  }, { status: 201, headers });
}, { requireRequestScope: true });

export const DELETE = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID.test(id)) return Response.json({ error: "Which link?" }, { status: 400, headers });
  /* An admin withdraws any link of this workspace; a private board's owner withdraws its links too (owner, 14 Oct: the owner sees and can revoke). Anyone else is told the same thing, whether or not the link exists. */
  if (got.user.role !== "admin" && !(await ownsShareProject(got.user.id, id))) return Response.json({ error: "An owner or admin withdraws a client link." }, { status: 403, headers });
  /* Scoped to this workspace in the platform database: another workspace's link id changes nothing. */
  return Response.json({ ok: await revokeShare(requireTenant().id, id, got.user.id) }, { headers });
}, { requireRequestScope: true });
