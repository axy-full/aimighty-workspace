import { NextResponse, type NextRequest } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { getStep, patchStep, type StepStatus } from "@/lib/atomik";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES: StepStatus[] = ["proposed", "running", "done", "failed", "rejected"];

export const GET = withTenant(async function GET(_req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const step = await getStep(id);
  if (!step) return NextResponse.json({ error: "That step is gone." }, { status: 404 });
  return NextResponse.json(step);
});

/**
 * Change a proposed step, or record what became of it.
 *
 * Editing re-prices: `patchStep` recomputes the estimate whenever the model
 * or the parameters move, so the figure on the Approve button is always the
 * figure that would be charged. That is the reason the card is editable at
 * all — it is where someone changes their mind, not merely where they say
 * yes.
 *
 * A step that has already run is frozen. Re-pricing a render that has been
 * paid for would rewrite history, and the row is the receipt.
 */
export const PATCH = withTenant(async function PATCH(req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;

  const cur = await getStep(id);
  if (!cur) return NextResponse.json({ error: "That step is gone." }, { status: 404 });

  const b = await req.json().catch(() => ({}));
  const wantsEdit = b.prompt !== undefined || b.model !== undefined || b.params !== undefined;
  if (wantsEdit && cur.status !== "proposed") {
    return NextResponse.json(
      { error: "That one has already run. Ask for a new version instead." },
      { status: 409 },
    );
  }

  const status = STATUSES.includes(b.status) ? b.status as StepStatus : undefined;
  const step = await patchStep(id, {
    prompt: typeof b.prompt === "string" ? b.prompt : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
    params: b.params && typeof b.params === "object" ? b.params : undefined,
    status,
    genId: b.genId === undefined ? undefined : (b.genId || null),
    error: b.error === undefined ? undefined : (b.error || null),
  });
  return NextResponse.json(step);
});
