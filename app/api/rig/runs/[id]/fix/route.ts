import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { applyFix } from "@/lib/runs";

/**
 * Take one of the priced ways out of a stopped stage.
 *
 * requireRender, not requireUser: a fix can put work back in the queue, so
 * the door is the one the press uses. Nothing is charged here — the work a
 * fix causes is charged when it runs, by the meter, like everything else.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const stageId = String(body.stageId ?? "");
  const fixId = String(body.fixId ?? "");
  if (!stageId || !fixId) return NextResponse.json({ error: "Name the stage and the fix." }, { status: 400 });

  const out = await applyFix(id, stageId, fixId, got.user.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 });
  return NextResponse.json({ ok: true, state: out.state });
});
