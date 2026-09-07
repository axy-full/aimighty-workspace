import { NextResponse } from "next/server";
import { requireSuperAdmin, withTenant } from "@/lib/auth";
import { currentTenant } from "@/lib/tenant";
import { db, ready } from "@/lib/db";
import { listPlatformAssets, putPlatformAsset } from "@/lib/platform";
import { readVideoBytes, storePlatformBytes } from "@/lib/storage";
import { previewPlan, PREVIEW_MODELS, PREVIEW_RESOLUTIONS, PREVIEW_DURATIONS } from "@/lib/previews";

export const dynamic = "force-dynamic";

/**
 * The previews batch, from the console (brief 1.4). GET says what the batch
 * would cost and where the workspace stands; the clips themselves are
 * ordinary renders the console posts to /api/generate with `previewFor`,
 * in the current workspace — which has to be an internal test workspace.
 * POST publish copies the finished clips into platform assets, once.
 */
function planFrom(url: URL) {
  const model = String(url.searchParams.get("model") ?? PREVIEW_MODELS[0]);
  const resolution = String(url.searchParams.get("resolution") ?? PREVIEW_RESOLUTIONS[0]);
  const duration = Number(url.searchParams.get("duration") ?? PREVIEW_DURATIONS[0]);
  return previewPlan(
    (PREVIEW_MODELS as readonly string[]).includes(model) ? model : PREVIEW_MODELS[0],
    (PREVIEW_RESOLUTIONS as readonly string[]).includes(resolution) ? resolution : PREVIEW_RESOLUTIONS[0],
    (PREVIEW_DURATIONS as readonly number[]).includes(duration) ? duration : PREVIEW_DURATIONS[0],
  );
}

type Candidate = { genId: string; key: string; model: string; costUsd: number | null; status: string; createdAt: number };

async function candidates(): Promise<Candidate[]> {
  await ready();
  const rs = await db().execute(
    `SELECT id, model, cost_usd, status, created_at, json_extract(params, '$.previewFor') AS pf FROM generations
     WHERE json_extract(params, '$.previewFor') IS NOT NULL AND deleted = 0 ORDER BY created_at DESC`,
  );
  const seen = new Set<string>(); const out: Candidate[] = [];
  for (const r of rs.rows as unknown as Record<string, unknown>[]) {
    const key = String(r.pf); if (seen.has(key)) continue; seen.add(key);
    out.push({ genId: String(r.id), key, model: String(r.model), costUsd: r.cost_usd == null ? null : Number(r.cost_usd), status: String(r.status), createdAt: Number(r.created_at) });
  }
  return out;
}

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  const plan = planFrom(new URL(req.url));
  const assets = await listPlatformAssets("previews/");
  const here = ws ? await candidates() : [];
  return NextResponse.json({
    plan: { ...plan, items: plan.items.map((i) => ({ key: i.key, label: i.label, kind: i.kind })) },
    scene: plan.items[0]?.prompt ?? "",
    workspace: ws ? { id: ws.id, name: ws.name, internalTest: Boolean(ws.internalTest) } : null,
    candidates: here,
    assets: assets.map((a) => ({ key: a.key.replace(/^previews\//, ""), bytes: a.bytes, model: a.model, costUsd: a.costUsd, createdAt: a.createdAt, sourceWorkspaceId: a.sourceWorkspaceId })),
  });
});

/** Publish: every finished clip rendered here for a preview becomes the platform's — the first and only time. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const ws = currentTenant()?.workspace;
  if (!ws?.internalTest) return NextResponse.json({ error: "Previews are published from an internal test workspace only." }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  if (body.action !== "publish") return NextResponse.json({ error: "action must be publish." }, { status: 400 });
  const published: string[] = []; const failed: { key: string; error: string }[] = [];
  for (const c of (await candidates()).filter((c) => c.status === "succeeded")) {
    try {
      const buf = await readVideoBytes(c.genId);
      const path = await storePlatformBytes(`previews/${c.key}.mp4`, buf, "video/mp4");
      await putPlatformAsset({ key: `previews/${c.key}`, path, bytes: buf.length, mime: "video/mp4", sourceWorkspaceId: ws.id, sourceGenId: c.genId, model: c.model, costUsd: c.costUsd, by: got.user.id });
      published.push(c.key);
    } catch (e) { failed.push({ key: c.key, error: (e as Error).message }); }
  }
  return NextResponse.json({ published, failed });
});
