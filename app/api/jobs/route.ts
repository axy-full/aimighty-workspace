import { NextResponse } from "next/server";
import { listGenerations, syncActive } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 60;

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const search = url.searchParams.get("q") ?? undefined;
  const before = Number(url.searchParams.get("before") ?? 0) || null;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? PAGE), 500);

  // Reconcile anything actually in flight before answering. This is a no-op —
  // one indexed lookup — whenever nothing is rendering, which is most of the
  // time; the cron owns repairs and janitorial work.
  if (url.searchParams.get("sync") !== "0") {
    try { await syncActive(); } catch { /* listing still works */ }
  }

  const generations = await listGenerations({
    projectId: projectId && projectId !== "all" ? projectId : undefined,
    createdBy: url.searchParams.get("mine") === "1" ? got.user.id : undefined,
    status: url.searchParams.get("status") ?? undefined,
    kind: url.searchParams.get("kind") ?? undefined,
    identityId: url.searchParams.get("identityId") ?? undefined,
    castName: url.searchParams.get("castName") ?? undefined,
    search,
    before,
    limit,
  });

  // Keyset cursor: the oldest row we just returned. Null once a page comes
  // back short, which is how the client knows it has reached the end.
  const nextCursor =
    generations.length === limit ? generations[generations.length - 1].createdAt : null;

  return NextResponse.json({ generations, nextCursor });
});
