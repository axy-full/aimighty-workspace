import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { setRunState } from "@/lib/runs";

/** Hold a run where it is, or let it go on. Nothing already made is touched. */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const want = body.state === "paused" ? "paused" : body.state === "running" ? "running" : null;
  if (!want) return NextResponse.json({ error: "A run is either running or paused." }, { status: 400 });

  const ok = await setRunState(id, want, got.user.id);
  if (!ok) return NextResponse.json({ error: "No such run." }, { status: 404 });
  return NextResponse.json({ ok: true, state: want });
});
