import { NextResponse, after } from "next/server";
import { allowanceCheck } from "@/lib/allowance";
import { checkLimits } from "@/lib/limits";
import { db, ready, now, id as newId } from "@/lib/db";
import { requireRender, withTenant } from "@/lib/auth";
import { getIdentity, runIdentityRender, promptWithTrigger, RENDERER, RENDER_RATIOS, RENDER_USD_PER_MP } from "@/lib/identities";
import { falConfigured } from "@/lib/fal";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { meter } from "@/lib/meter";

import { withGenerationRequest, bindGenerationRequest, reserveGenerationSpend, SpendReservationError } from "@/lib/generationRequests";
import { currentTenant, runWithStore } from "@/lib/tenant";

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
  return withGenerationRequest(req, got.user.id, async (requestClaim) => {
  const { id } = await params;
  const identity = await getIdentity(id);
  if (!identity) return NextResponse.json({ error: "No such identity." }, { status: 404 });
  if (identity.status !== "ready" || !identity.loraUrl) {
    return NextResponse.json({ error: "Train the identity first." }, { status: 400 });
  }
  if (!falConfigured()) {
    return NextResponse.json({ error: "Identities aren't connected for this workspace. Ask the platform to connect them." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "Say what the shot is." }, { status: 400 });
  const ratio = (RENDER_RATIOS as readonly string[]).includes(String(body.ratio)) ? String(body.ratio) : "16:9";
  const count = Math.max(1, Math.min(4, Math.floor(Number(body.count ?? 1)) || 1));
  const seed = body.seed === "" || body.seed == null ? null : Number(body.seed);
  const projectId = body.projectId ? String(body.projectId) : identity.projectId;
  const finalPrompt = promptWithTrigger(prompt, identity);

  /* Priced at what it will actually cost, and checked once the COUNT is
     known. The wall used to run before the body was read, so it asked
     `allowanceCheck("fal")` with no estimate at all — a zero — which
     answers "can this workspace spend nothing?" and lets four stills
     through on one credit. It also ran outside the rate limit entirely, so
     nothing bounded how many times a second it could be asked.
     Same walls, same order, as every other paid route. */
  const estUsd = Math.round(RENDER_USD_PER_MP * count * 10_000) / 10_000;
  const allowance = await allowanceCheck("fal", estUsd, RENDERER);
  if (!allowance.ok) return NextResponse.json({ error: allowance.error }, { status: allowance.status });
  const lim = await checkLimits();
  if (!lim.allow) return NextResponse.json({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });

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
  await bindGenerationRequest(requestClaim, ids[0]);
  invalidate(PROJECTS_KEY);
  const reserved: string[] = [];
  try {
    for (const gid of ids) {
      await reserveGenerationSpend({ id: gid, kind: "image", engine: "fal", model: RENDERER, status: "running",
                    engineCostUsd: RENDER_USD_PER_MP, projectId, createdBy: got.user.id }, { token: got.token });
      reserved.push(gid);
    }
  } catch (e) {
    for (const gid of reserved) await meter({ id: gid, kind: "image", engine: "fal", model: RENDERER, status: "failed", engineCostUsd: 0 });
    for (const gid of ids) {
      await db().execute({ sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`, args: [(e as Error).message, now(), gid] }).catch(() => {});
    }
    invalidate(PROJECTS_KEY);
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }

  const store = currentTenant()!;
  after(() => runWithStore(store, async () => {
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
  }));

  return NextResponse.json({ ids, status: "running" });
  });
});
