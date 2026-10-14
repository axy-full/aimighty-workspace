import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { RetryRefused, listFailedSaves, retryFailedSave } from "@/lib/platformFailedSaves";

export const dynamic = "force-dynamic";

/** Renders that finished but were never stored, across every workspace. The platform owner only. */
export const GET = recoveryRoute(async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  return NextResponse.json(await listFailedSaves(), { headers: { "Cache-Control": "no-store" } });
});

/** Try to save one of them again: `{ workspaceId, id }`. It is the heartbeat's own path for one render and spends nothing new. */
export const POST = recoveryRoute(async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = (await req.json().catch(() => ({}))) as { workspaceId?: unknown; id?: unknown };
  if (typeof body.workspaceId !== "string" || typeof body.id !== "string" || !body.workspaceId || !body.id)
    return NextResponse.json({ error: "Name the workspace and the render." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await retryFailedSave({ workspaceId: body.workspaceId, id: body.id, actorId: got.user.id })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RetryRefused) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "It could not be saved just now. The heartbeat will keep trying." }, { status: 502 });
  }
});
