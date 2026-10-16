import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { requireSession, requireUser, withTenant } from "@/lib/auth";
import { creditsApply, quotedCredits } from "@/lib/credits";
import { db, id as newId, now, ready } from "@/lib/db";
import { mayReachProject } from "@/lib/draftProject";
import { engineMock } from "@/lib/mock";
import { storeImageBytes } from "@/lib/storage";
import { requireTenant } from "@/lib/tenant";
import { STILL_LIMITS, stillProblem, type StillAsk, type StillTool } from "@/lib/v12/tools/stills";

export const dynamic = "force-dynamic";

/**
 * The still tools' STAND-IN (lib/v12/tools/stills.ts), until BFL's FLUX.2 (#778/#785) and Recraft (#786) land.
 *
 * It answers only under ENGINE_MOCK=1; everywhere else it is "no such tool", so it can never bill. Nothing leaves the process: each still is
 * the repo's sample picture, stored and filed as a take of the production like a real one. It is priced through the same path as any
 * still (`quotedCredits`, so the margin table and the workspace's unit apply) from a made-up engine cost that exists only here. A quote may be
 * asked by anyone signed in; a run is a person's press (a token is refused) and needs the figure the quote gave. It writes no meter row: it
 * moves no money.
 */
const MOCK_USD_PER_STILL = 0.04;
const PICTURE: Record<StillTool, string> = { portrait: "character.webp", sheet: "character.webp", panel: "hero.webp" };
const MODEL: Record<StillTool, string> = { portrait: "flux-2-pro", sheet: "flux-2-pro", panel: "recraft-v3" };
const TOOLS: readonly StillTool[] = ["portrait", "sheet", "panel"];

export const POST = withTenant(async function POST(req: Request) {
  if (!engineMock()) return NextResponse.json({ error: "There is no such tool here." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const run = body.mode === "run";
  const got = run ? await requireSession() : await requireUser();
  if (got.response) return got.response;
  const tool = body.tool as StillTool;
  if (!TOOLS.includes(tool)) return NextResponse.json({ error: "Pick portrait, sheet or panel." }, { status: 400 });
  const items = Array.isArray(body.items) ? (body.items as unknown[]).flatMap((i) => {
    const r = i as Record<string, unknown> | null;
    return r && typeof r.key === "string" && typeof r.prompt === "string" ? [{ key: r.key, prompt: r.prompt }] : [];
  }) : [];
  const ask: StillAsk = { tool, projectId: typeof body.projectId === "string" ? body.projectId : null, items };
  const problem = stillProblem(ask);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (items.length > STILL_LIMITS[tool]) return NextResponse.json({ error: `Up to ${STILL_LIMITS[tool]} at a time.` }, { status: 400 });

  const usd = Math.round(items.length * MOCK_USD_PER_STILL * 1e6) / 1e6;
  const estimatedCredits = quotedCredits(usd, MODEL[tool]);
  const inCredits = creditsApply(requireTenant());
  const price = inCredits ? estimatedCredits : usd;
  if (!run) return NextResponse.json({ estimatedCredits, price, unit: inCredits ? "cr" : "usd", count: items.length });
  if (typeof body.approved !== "number" || !Number.isFinite(body.approved) || body.approved < price)
    return NextResponse.json({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  await ready();
  const production = ask.projectId;
  if (production && !(await mayReachProject(got.user, production, "write"))) return NextResponse.json({ error: "That production is not in this workspace." }, { status: 404 });

  const picture = await sharp(await readFile(path.join(process.cwd(), "public", "campaign", PICTURE[tool]))).png().toBuffer();
  const takes: { key: string; genId: string }[] = [];
  for (const item of items) {
    const genId = newId("gen");
    const stored = await storeImageBytes(genId, picture);
    const at = now();
    await db().execute({
      sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,bytes,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,deleted)
            VALUES (?,?,NULL,'image',?,?,?,'succeeded',?,?,0,?,?,?,1,'stand-in','generate','',0)`,
      args: [genId, production, MODEL[tool], item.prompt.slice(0, 5000), JSON.stringify({ via: "stills-stand-in", tool, key: item.key }), stored.url, stored.bytes, got.user.id, at, at],
    });
    takes.push({ key: item.key, genId });
  }
  return NextResponse.json({ ok: true, tool, estimatedCredits, takes });
});
