import { NextResponse, after } from "next/server";
import { allowanceCheck } from "@/lib/allowance";
import { db, ready, now, id as newId } from "@/lib/db";
import { requireRender, withTenant } from "@/lib/auth";
import { getIdentity, runIdentityRender, promptWithTrigger, RENDERER, RENDER_RATIOS } from "@/lib/identities";
import { falConfigured } from "@/lib/fal";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/**
 * Stills of a trained identity. Each image is its own render on the wall
 * and the ledger, like every other; they run after the response goes out.
 */
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const identity = await getIdentity(id);
  if (!identity) return NextResponse.json({ error: "No such identity." }, { status: 404 });
  if (identity.status !== "ready" || !identity.loraUrl) {
    return NextResponse.json({ error: "Train the identity first." }, { status: 400 });
  }
  if (!falConfigured()) {
    return NextResponse.json({ error: "fal.ai isn't connected for this workspace — add its key under Settings › Vendors & keys." }, { status: 400 });
  }
  const allowance = await allowanceCheck("fal");
  if (!allowance.ok) return NextResponse.json({ error: allowance.error }, { status: allowance.status });
  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "Say what the shot is." }, { status: 400 });
  const ratio = (RENDER_RATIOS as readonly string[]).includes(String(body.ratio)) ? String(body.ratio) : "16:9";
  const count = Math.max(1, Math.min(4, Number(body.count ?? 1) || 1));
  const seed = body.seed === "" || body.seed == null ? null : Number(body.seed);
  const projectId = body.projectId ? String(body.projectId) : identity.projectId;
  const finalPrompt = promptWithTrigger(prompt, identity);

  const ids: string[] = [];
  const ts = now();
  for (let i = 0; i < count; i++) {
    const genId = newId("gen");
    ids.push(genId);
    await db().execute({
      sql: `INSERT INTO generations
            (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
             created_at, updated_at, token_id, provider, task, billed_to)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, projectId, null, "image", RENDERER, finalPrompt,
             JSON.stringify({
               ratio, resolution: "1K", rawPrompt: prompt,
               identity: { id: identity.id, name: identity.name },
               cast: [identity.name],
               seed: seed != null && Number.isFinite(seed) ? seed + i : undefined,
             }),
             "running", got.user.id, ts, ts, got.token?.id ?? null, "fal", "generate", "fal"],
    });
  }
  invalidate(PROJECTS_KEY);

  after(async () => {
    // Two at a time: fal queues the rest anyway, and the wall fills in as
    // each lands rather than all at once.
    const queue = [...ids];
    const worker = async () => {
      for (;;) {
        const genId = queue.shift();
        if (!genId) return;
        const i = ids.indexOf(genId);
        await runIdentityRender(genId, identity, {
          prompt: finalPrompt, ratio,
          seed: seed != null && Number.isFinite(seed) ? seed + i : null,
          startedAt: ts,
        });
      }
    };
    await Promise.all([worker(), worker()]);
  });

  return NextResponse.json({ ids, status: "running" });
});
