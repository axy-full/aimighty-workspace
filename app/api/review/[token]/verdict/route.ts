import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { recordVerdict, scopeOf, underLimit } from "@/lib/security/review-link";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };
const headers = { "Cache-Control": "no-store" };

/**
 * A client's decision on one take, from a Crew review link (Gaps A): Approve, or Request changes, with an optional
 * comment. No sign-in: the link is the permission, and it reaches only its own production's review set. It is kept
 * beside the team's review, never written over it, and it spends nothing. Limited per link.
 */
export const POST = async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  const found = await resolveShare(token);
  if (!found) return Response.json({ error: "This review link has expired or been withdrawn." }, { status: 404, headers });
  const body = await req.json().catch(() => ({}));
  const out = await runInTenant(found.workspace, async () => {
    if ((await scopeOf(found.share.id)) !== "review") return { ok: false as const, status: 403, error: "This link is for watching only." };
    if (!(await underLimit(found.share.id, "write"))) return { ok: false as const, status: 429, error: "Too many changes from this link. Wait a few minutes and try again." };
    return recordVerdict({ shareId: found.share.id, projectId: found.share.projectId, genId: String(body?.genId ?? ""), verdict: body?.verdict, name: body?.name, text: body?.text });
  });
  if (!out.ok) return Response.json({ error: out.error }, { status: out.status, headers });
  return Response.json({ ok: true, author: out.guest }, { status: 201, headers });
};
