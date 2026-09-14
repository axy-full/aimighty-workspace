import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { uploadSessionStatus, uploadFailure } from "@/lib/uploadReservations";
export const dynamic = "force-dynamic";
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  try {
    const status = await uploadSessionStatus(got.user.id, new URL(req.url).searchParams.get("session") ?? "");
    if (!status) return Response.json({ error: "This upload session has not started." }, { status: 404 });
    return Response.json(status, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error); }
});
