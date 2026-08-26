import { NextResponse } from "next/server";
import { listGenerations, syncPending } from "@/lib/jobs";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const search = url.searchParams.get("q") ?? undefined;

  // Reconcile anything still in flight before answering.
  if (url.searchParams.get("sync") !== "0") {
    try { await syncPending(); } catch { /* listing still works */ }
  }

  const generations = await listGenerations({
    projectId: projectId && projectId !== "all" ? projectId : undefined,
    createdBy: url.searchParams.get("mine") === "1" ? got.user.id : undefined,
    search,
    limit: Number(url.searchParams.get("limit") ?? 200),
  });
  return NextResponse.json({ generations });
}
