import { NextResponse, after } from "next/server";
import { getGeneration } from "@/lib/jobs";
import { requireRender, withTenant } from "@/lib/auth";
import { releaseHeldJobs } from "@/lib/held";
import { creditState } from "@/lib/credits";
import { switchProviderOf } from "@/lib/meter";
import { engineOff } from "@/lib/platform";
import { enginePausedSentence } from "@/lib/platformLayer";
import { PROVIDERS } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/**
 * Release one held take, if the balance now covers it. Its author or an admin may.
 *
 * requireRender, not requireUser: a release starts a paid render, so it is
 * refused the way a press is — 423 with the suspension sentence for a
 * suspended workspace (releaseHeldJobs releases nothing there and the old
 * 402 read as a credit shortfall), 403 for a read-only token.
 */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (gen.status !== "held") return NextResponse.json({ error: "This take is not held." }, { status: 409 });
  if (got.user.role !== "admin" && gen.createdBy !== got.user.id) {
    return NextResponse.json({ error: "Only the person who made this take, or an admin, can release it." }, { status: 403 });
  }
  /* The kill switch (SOW v2 §9): a take on a provider the platform paused
     stays held — releaseHeldJobs skips it — and the answer is the paused
     sentence, not "Still short". Keyed by the model's own vendor, as the
     release loop keys it. A layer that cannot be read does not refuse. */
  const pid = switchProviderOf(gen.model, gen.provider);
  const gate = await engineOff(pid).catch(() => ({ off: false, reason: null as string | null }));
  if (gate.off) {
    const label = PROVIDERS.find((p) => p.id === pid)?.label ?? pid;
    return NextResponse.json({ error: enginePausedSentence(label, gate.reason) }, { status: 503 });
  }
  const out = await releaseHeldJobs({ only: id, defer: (fn) => after(fn) });
  if (!out.released.length) {
    const needs = Number((gen.params as { held?: { needs?: number } }).held?.needs ?? 0);
    const left = (await creditState())?.balance ?? 0;
    return NextResponse.json({ error: `Still short: this needs ${needs} credits and ${Math.max(0, Math.floor(left))} are left.` }, { status: 402 });
  }
  return NextResponse.json({ released: true, id });
});
