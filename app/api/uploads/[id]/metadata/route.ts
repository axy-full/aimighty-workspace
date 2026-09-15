import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { getLibraryUpload } from "@/lib/uploadLibrary";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Resolve a dragged original in the caller's workspace without downloading it. */
export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const upload = await getLibraryUpload((await params).id);
  return Response.json(upload ? { upload } : { error: "Not found" }, {
    status: upload ? 200 : 404,
    headers: { "Cache-Control": "private, no-store" },
  });
});
