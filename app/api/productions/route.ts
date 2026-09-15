import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listProductions, createProduction } from "@/lib/productions";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";

/** Board 7a: every production with its projects, counts and money. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  return NextResponse.json({ productions: await listProductions() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

/** `New production` (§6): a name, a client, and nothing else required. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const b = await req.json().catch(() => ({}));
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return NextResponse.json({ error: "A production needs a name." }, { status: 400 });
  const id = await createProduction({ name, client: typeof b.client === "string" ? b.client : "" });
  return NextResponse.json({ id }, { status: 201 });
});
