import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { patchProduction, type ProductionStatus } from "@/lib/productions";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Rename, re-client, deliver, or cap a production. */
export const PATCH = withTenant(async function PATCH(req: Request, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const status: ProductionStatus | undefined = b.status === "delivered" || b.status === "active" ? b.status : undefined;
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
