import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listThreads } from "@/lib/atomikThreads";

export const dynamic = "force-dynamic";

/**
 * A project's Atomik threads (lib/atomikThreads.ts), newest activity first:
 * each with its title, who started it, where it stands and when it last
 * moved. Free: nothing here calls a model or a vendor.
 *
 *  GET ?projectId=            the project's threads (none: the ones filed under no project)
 *  GET ?projectId=&archived=1 the ones archived, to restore
 *
 * Starting a thread is starting a chat (POST /api/atomik); renaming,
 * archiving and restoring one is PATCH /api/atomik/:id.
 */
export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const params = new URL(req.url).searchParams;
  const projectId = (params.get("projectId") ?? "").trim();
  if (projectId.length > 120) return NextResponse.json({ error: "That project is not one of this workspace's." }, { status: 400 });
  const threads = await listThreads(projectId || null, got.user.id, { archived: params.get("archived") === "1" });
  return NextResponse.json({ threads }, { headers: { "Cache-Control": "no-store" } });
});
