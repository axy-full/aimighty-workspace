import { isJob } from "@/lib/takeJob";
import { isShotType } from "@/lib/takeShotType";
import { NextResponse, after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { hasActiveGenerations, listGenerations, syncActive } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { assetCursor, assetPageQuery, AssetQueryError } from "@/lib/assetPagination";
import { withLedgerCharges } from "@/lib/usageLedger";
import { trayJobs } from "@/lib/jobsTray.server";
import { statusFilter } from "@/lib/jobsTray";

export const dynamic = "force-dynamic";
/* The list answers at once; this is the budget for the reconciliation it
   leaves running after the response, which may store a finished master. */
export const maxDuration = 300;

const PAGE = 60;

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  const url = new URL(req.url);
  const view = url.searchParams.get("view");
  if (view !== null && view !== "tray") return NextResponse.json({ error: "Unknown view." }, { status: 400 });
  const filter = statusFilter(url.searchParams.get("status"));
  /* Make's own results (lib/madeIn.ts): the one value there is; anything else is not a filter this route has. */
  const madeIn = url.searchParams.get("madeIn");
  if (madeIn !== null && (madeIn !== "make" || url.searchParams.getAll("madeIn").length > 1)) return NextResponse.json({ error: "Unknown madeIn." }, { status: 400 });
  /* A take's job (lib/takeJob.ts): one value from the closed list. */
  const job = url.searchParams.get("job");
  if (job !== null && (!isJob(job) || url.searchParams.getAll("job").length > 1)) return NextResponse.json({ error: "Unknown job." }, { status: 400 });
  /* A take's shot type (lib/takeShotType.ts): one value from the closed list. */
  const shotType = url.searchParams.get("shotType");
  if (shotType !== null && (!isShotType(shotType) || url.searchParams.getAll("shotType").length > 1)) return NextResponse.json({ error: "Unknown shot type." }, { status: 400 });
  const stable = url.searchParams.get("pagination") === "stable";
  let page: ReturnType<typeof assetPageQuery> | null = null;
  try {
    if (url.searchParams.has("pagination") && (!stable || url.searchParams.getAll("pagination").length > 1))
      throw new AssetQueryError("Invalid pagination mode.");
    if (stable && url.searchParams.has("before"))
      throw new AssetQueryError("Use cursor instead of before for stable pagination.");
    if (!stable && url.searchParams.has("cursor"))
      throw new AssetQueryError("Choose stable pagination to use an asset cursor.");
    if (stable) page = assetPageQuery(url.searchParams, PAGE);
  } catch (error) {
    if (error instanceof AssetQueryError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const projectId = url.searchParams.get("projectId");
  const search = page ? page.search : url.searchParams.get("q") ?? undefined;
  const before = Number(url.searchParams.get("before") ?? 0) || null;
  const limit = page ? page.limit : Math.min(Number(url.searchParams.get("limit") ?? PAGE), 500);

  // Reconcile anything actually in flight — after answering, never before: a
  // render that lands may start a master download of up to 200 MB, and the
  // list must not wait on it. The next poll shows what landed. Whenever
  // nothing is rendering this is one indexed lookup and nothing is reserved;
  // the cron owns repairs.
  if (url.searchParams.get("sync") !== "0") {
    try {
      if (await hasActiveGenerations())
        after(await reserveRecoveryContinuation("after-response", () => syncActive().catch(() => { /* the next poll tries again */ })));
    } catch { /* listing still works */ }
  }

  /* The header's jobs tray: this person's own takes from both engines, in flight or just finished. */
  if (view === "tray")
    return NextResponse.json(await trayJobs(got.user.id), { headers: { "Cache-Control": "private, no-store" } });

  /* A private board's takes (lib/draftProject.ts) are its owner's, and the workspace's admins'; a shared board's and the sample's are for looking at. Left out of the list itself, so a page, its cursor and what it holds are this person's. A token acts as its person. */
  const rows = await listGenerations({
    viewer: got.user,
    projectId: projectId && projectId !== "all" ? projectId : undefined,
    createdBy: url.searchParams.get("mine") === "1" ? got.user.id : undefined,
    ...filter,
    kind: url.searchParams.get("kind") ?? undefined,
    identityId: url.searchParams.get("identityId") ?? undefined,
    castName: url.searchParams.get("castName") ?? undefined,
    unfiled: url.searchParams.get("unfiled") === "1",
    ...(madeIn === "make" ? { madeIn: "make" as const } : {}),
    ...(job !== null && isJob(job) ? { job } : {}),
    ...(shotType !== null && isShotType(shotType) ? { shotType } : {}),
    search,
    before,
    cursor: page?.cursor,
    includeNext: stable,
    limit,
  });
  /* A failed take carries what Particl's own ledger holds for it (credit workspaces). */
  const generations = await withLedgerCharges(stable ? rows.slice(0, limit) : rows);

  // Keyset cursor: the oldest row we just returned. Null once a page comes
  // back short, which is how the client knows it has reached the end.
  const nextCursor =
    generations.length === limit ? generations[generations.length - 1].createdAt : null;

  const last = generations.at(-1);
  const nextPageCursor = stable && rows.length > limit && last
    ? assetCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return NextResponse.json({ generations, nextCursor, nextPageCursor }, {
    headers: { "Cache-Control": "private, no-store" },
  });
});
