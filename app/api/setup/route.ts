import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { workspaceSetup, setWorkspaceSetup, productionSetup, setProductionSetup } from "@/lib/setup";

export const dynamic = "force-dynamic";

/**
 * The two middle Setup layers (brief 2.3), which used to live in localStorage.
 *
 * Scoping needs no WHERE clause here: withTenant decides WHICH DATABASE db()
 * hands out, so a workspace can only ever read and write its own. The
 * production write returns 404 rather than 403 for a project that is not in
 * this database — the caller learns nothing about what exists elsewhere.
 *
 * Any member may save these. That matches what they could already do when
 * these were browser-local, and Setup is a creative default, not policy: the
 * settings that are policy (the approval rule, the caps) keep requireAdmin.
 */

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const real = projectId && projectId !== "all" && projectId !== "unfiled" ? projectId : null;
  const [workspace, production] = await Promise.all([
    workspaceSetup(),
    real ? productionSetup(real) : Promise.resolve({}),
  ]);
  return NextResponse.json({ workspace, production });
});

export const PUT = withTenant(async function PUT(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const scope = String(body.scope ?? "");
  if (!scope) return NextResponse.json({ error: "Which Setup — the workspace's, or a production's?" }, { status: 400 });

  if (scope === "workspace" || scope === "all") {
    return NextResponse.json({ scope: "workspace", spec: await setWorkspaceSetup(body.spec, got.user.id) });
  }
  const spec = await setProductionSetup(scope, body.spec);
  if (!spec) return NextResponse.json({ error: "No such production here." }, { status: 404 });
  return NextResponse.json({ scope, spec });
});
