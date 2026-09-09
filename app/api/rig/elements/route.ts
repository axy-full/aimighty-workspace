import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listElements, ensureRig } from "@/lib/elements";

/**
 * The element library of the workspace in scope (brief 3).
 *
 * Read-only for now: what the layer holds, so the surfaces built on top of it
 * have something to read and so the backfill can be seen to have happened.
 * The first read of a workspace's library is what runs the backfill, once, so
 * no cold start pays for a migration nobody asked for.
 */
export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const backfill = await ensureRig(got.user.id);

  const projectId = new URL(req.url).searchParams.get("projectId");
  const scoped = projectId && projectId !== "all" && projectId !== "unfiled" ? projectId : null;
  const elements = await listElements(scoped);

  return NextResponse.json({ elements, backfill });
});
