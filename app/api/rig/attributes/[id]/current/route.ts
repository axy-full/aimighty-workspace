import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { db, ready, now } from "@/lib/db";
import { impactOf } from "@/lib/impact";
import { setCurrentVersion } from "@/lib/elements";
import { isChoiceKey, takesReturnedToDraft } from "@/lib/impactChoice";
import { isVisual, type AttributeKind } from "@/lib/rig";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

/**
 * Swap which version of an attribute everything follows (brief 3, surface 1b).
 *
 * This route is where the design's fifth rule lives: **nothing re-renders
 * silently.** A swap without a decision about the takes that already exist is
 * refused — 409, with the impact in the body — so the panel is not merely the
 * polite path to a change but the only one. A client that forgot to ask gets
 * the question back rather than a quiet re-render.
 *
 * What the choice actually does here is bounded and spends nothing. The
 * attribute moves, and the approved takes the choice reaches go back to draft,
 * because a take approved against the old version no longer shows what the
 * shot is. Rendering them again is a person pressing a priced button, the way
 * every other render in this product happens.
 *
 * **A swap is workspace-wide, so the question is asked workspace-wide.**
 * `current_id` is one column on one attribute: moving it moves every shot in
 * every production that follows this element. Pricing that against a single
 * production would show a producer three shots, take their answer, and move
 * nine more in a production the panel never named — rule 5 broken by the
 * route written to enforce it. Changing what ONE production uses is a
 * different act, a pin on those shots, and belongs to the bindings surface.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();

  const { id: attributeId } = await params;
  const body = await req.json().catch(() => ({}));
  const versionId = String(body.versionId ?? "");
  if (!versionId) return NextResponse.json({ error: "Name the version to move to." }, { status: 400 });

  const rs = await db().execute({
    sql: `SELECT v.id, v.element_id, v.status, a.current_id, a.kind
          FROM attribute_versions v JOIN element_attributes a ON a.id = v.attribute_id
          WHERE v.id = ? AND v.attribute_id = ?`,
    args: [versionId, attributeId],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "That version is not one of this attribute's." }, { status: 404 });
  const row = rs.rows[0] as unknown as { element_id: string; status: string; current_id: string | null; kind: string };

  /* A version whose views are still rendering is not something to point at:
     binding to it would quote for an image that does not exist yet. */
  if (String(row.status) !== "ready") {
    return NextResponse.json({ error: "That version is not ready yet." }, { status: 409 });
  }
  if (row.current_id === versionId) return NextResponse.json({ ok: true, unchanged: true });

  /* What this reaches, priced, before anything moves — every production of
     them, and only the shots that FOLLOW current, since a shot pinned to a
     version does not move when current does. */
  const impact = await impactOf(String(row.element_id), attributeId, versionId, {
    projectId: null, following: true, at: now(), isAdmin: got.user.role === "admin",
  });

  if (!isChoiceKey(body.choice)) {
    return NextResponse.json(
      { error: "Choose what happens to the takes that already exist.", needsChoice: true, impact },
      { status: 409 });
  }

  const chosen = impact.choices.find((c) => c.key === body.choice)!;
  if (!chosen.verdict.allow) {
    return NextResponse.json({ error: chosen.verdict.line, impact }, { status: 409 });
  }

  await setCurrentVersion(attributeId, versionId);

  /* The takes the choice reaches go back to draft. "Approved only" and "all"
     both return the approved ones, because those are the only takes a state
     change means anything to; a draft was never signed off against the old
     version in the first place. */
  let returned = 0;
  if (takesReturnedToDraft(body.choice) !== "none") {
    const shots = impact.shots.filter((s) => s.approved).map((s) => s.shotId);
    if (shots.length) {
      const holes = shots.map(() => "?").join(",");
      /* Only the takes this attribute could have changed. A wardrobe or a
         plate is in the picture; it is not in the sound, and un-approving a
         production's audio because a coat changed is a signature destroyed
         for nothing. */
      const kinds = isVisual(String(row.kind) as AttributeKind) ? ["video", "image"] : ["audio"];
      const kindHoles = kinds.map(() => "?").join(",");
      /* review_state alone. approved_by and approved_at are the approval
         trail brief 2.1 exists for, and /api/jobs/[id] deliberately keeps
         them when it clears a state: who signed a take off, and when, is a
         record and not a status. */
      const out = await db().execute({
        sql: `UPDATE generations SET review_state = '', updated_at = ?
              WHERE shot_id IN (${holes}) AND review_state = 'approved' AND deleted = 0
                AND kind IN (${kindHoles})`,
        args: [now(), ...shots, ...kinds],
      });
      returned = out.rowsAffected;
    }
  }
  /* Approved counts are memoised for the projects list; anything that writes
     must invalidate, or the wall reports approvals that no longer exist. */
  invalidate(PROJECTS_KEY);

  return NextResponse.json({
    ok: true, choice: body.choice,
    credits: chosen.quote.totalCredits,
    shots: chosen.shots,
    returnedToDraft: returned,
  });
});
