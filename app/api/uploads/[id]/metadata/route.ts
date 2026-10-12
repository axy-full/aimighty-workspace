import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { getLibraryUpload } from "@/lib/uploadLibrary";
import { uploadOpenableBy } from "@/lib/uploadAccess";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Resolve a dragged original in the caller's workspace without downloading it. */
export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const id = (await params).id;
  const upload = (await uploadOpenableBy(id, got.user)) ? await getLibraryUpload(id) : null;
  return Response.json(upload ? { upload } : { error: "Not found" }, {
    status: upload ? 200 : 404,
    headers: { "Cache-Control": "private, no-store" },
  });
});
