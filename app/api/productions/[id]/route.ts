import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { patchProduction, type ProductionStatus } from "@/lib/productions";
import { db, ready } from "@/lib/db";
import { NOT_YOURS, mayChangeProduction } from "@/lib/workAccess";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Rename, re-client, deliver, or cap a production. */
export const PATCH = withTenant(async function PATCH(req: Request, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  /* A cap is a spend limit: an admin's, and a person's (CLAUDE.md rule 14). A member or any API or MCP token is refused. */
  if (b.capCredits !== undefined || b.capUsd !== undefined) {
    if (got.token) return NextResponse.json({ error: "A production's cap is set by a person, signed in. API tokens cannot change it." }, { status: 403 });
    if (got.user.role !== "admin") return NextResponse.json({ error: "An admin sets a production's cap." }, { status: 403 });
  }
  const status: ProductionStatus | undefined = b.status === "delivered" || b.status === "active" ? b.status : undefined;
  /* A name, a client or a status of a production that is there is changed by an admin, or the one person who made every board in it (lib/workAccess.ts); an unknown id is answered as it always was. */
  if (typeof b.name === "string" || typeof b.client === "string" || status !== undefined) {
    await ready();
    if ((await db().execute({ sql: "SELECT 1 FROM productions WHERE id = ?", args: [id] })).rows.length && !(await mayChangeProduction(got.user, id)))
      return NextResponse.json({ error: NOT_YOURS.production }, { status: 403 });
  }
  const ok = await patchProduction(id, {
    name: typeof b.name === "string" ? b.name : undefined,
    client: typeof b.client === "string" ? b.client : undefined,
    status,
    capCredits: b.capCredits === undefined ? undefined : (b.capCredits === null || b.capCredits === "" ? null : Math.round(Number(b.capCredits))),
    capUsd: b.capUsd === undefined ? undefined : (b.capUsd === null || b.capUsd === "" ? null : Number(b.capUsd)),
  });
  if (!ok) return NextResponse.json({ error: "No such production." }, { status: 404 });
  return NextResponse.json({ ok: true });
});
