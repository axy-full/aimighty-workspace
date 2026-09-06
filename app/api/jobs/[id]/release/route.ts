import { NextResponse, after } from "next/server";
import { getGeneration } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";
import { releaseHeldJobs } from "@/lib/held";
import { creditState } from "@/lib/credits";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Release one held take, if the balance now covers it. Its author or an admin may. */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (gen.status !== "held") return NextResponse.json({ error: "This take is not held." }, { status: 409 });
  if (got.user.role !== "admin" && gen.createdBy !== got.user.id) {
    return NextResponse.json({ error: "Only the person who made this take, or an admin, can release it." }, { status: 403 });
  }
  const out = await releaseHeldJobs({ only: id, defer: (fn) => after(fn) });
  if (!out.released.length) {
    const needs = Number((gen.params as { held?: { needs?: number } }).held?.needs ?? 0);
    const left = (await creditState())?.balance ?? 0;
    return NextResponse.json({ error: `Still short: this needs ${needs} credits and ${Math.max(0, Math.floor(left))} are left.` }, { status: 402 });
  }
  return NextResponse.json({ released: true, id });
});
