import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { provenanceOf } from "@/lib/provenance";

/**
 * What produced one take (brief 3, surface 1c).
 *
 * A take made before this was recorded answers with `recorded: null` rather
 * than a guess. The card says so plainly: a provenance card that invented
 * the seed it did not have would be worse than one that admits it.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;

  const rs = await db().execute({
    sql: `SELECT g.id, g.shot_id, g.version, g.model, g.review_state, g.created_by, g.created_at,
                 g.cost_usd, g.kind, s.code AS shot_code, s.title AS shot_title
          FROM generations g LEFT JOIN shots s ON s.id = g.shot_id
          WHERE g.id = ? AND g.deleted = 0`,
    args: [id],
  });
  if (!rs.rows.length) return NextResponse.json({ error: "No such take." }, { status: 404 });
  const r = rs.rows[0] as unknown as Record<string, unknown>;

  return NextResponse.json({
    take: {
      id: String(r.id),
      shotId: r.shot_id ?? null,
      shotCode: String(r.shot_code ?? ""),
      shotTitle: String(r.shot_title ?? ""),
      version: Number(r.version ?? 1),
      model: String(r.model ?? ""),
      state: String(r.review_state ?? ""),
      by: String(r.created_by ?? ""),
      at: Number(r.created_at ?? 0),
      kind: String(r.kind ?? "video"),
    },
    provenance: await provenanceOf(id),
  });
});
