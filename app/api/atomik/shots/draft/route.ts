import { vendorKey } from '@/lib/vendorKeys';
import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";

import { getTreatment } from "@/lib/atomikDocs";
import { listCast } from "@/lib/cast";
import { requestEffort, resolveModel } from "@/lib/atomik";
import { gatewayReachable } from "@/lib/gateway";
import { specToPhrase } from "@/lib/studio";
import { shotsFromReply, setupVocabulary, suggestEngine } from "@/lib/shotBuilder";
import { shotCostUsd } from "@/lib/shotCost";

import { runPaidText, quotePaidText, paidTextQuoteResponse, requestMaxCredits, paidTextQuoteScopeFailure, paidTextFailure } from "@/lib/paidText";
import { withGenerationRequest } from "@/lib/generationRequests";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = [
  "You break ONE scene of a film treatment into shots for a production studio. Every shot must be filmable as a single generated clip of 2 to 15 seconds.",
  "For each shot give a short title, a one-paragraph description in present tense (what is in frame and what happens — no camera jargon in the prose),",
  "planned seconds, the setup as FIELDS using only the values listed (leave a row out if nothing fits), the cast as @Name from the names given,",
  "the engine — \"kling\" for water, cloth, hair, smoke and physics-heavy motion, \"seedance\" for everything else — and one short line of why.",
  'Return ONLY a JSON object: {"shots": [{"title": string, "description": string, "planned": number, "setup": {row: value}, "cast": string[], "engine": "seedance"|"kling", "why": string}]} — no prose outside it, no code fence.',
].join(" ");

/**
 * The shot builder (brief 1.8): a scene in, a shot list out with every Setup
 * row as a field, cast tagged, an engine per shot and a credit estimate per
 * shot and for the scene — before anything is rendered. Proposals only:
 * nothing is written until a person adds a shot.
 */
export const POST = withTenant(async function POST(req: Request) {
  /* requireRender, not requireUser. This spends the platform's AI-Gateway
     credit, and requireUser accepts a bearer of ANY scope — including the
     read-only token /connect hands to MCP clients precisely because it
     "cannot bill". The identity and ideas routes were moved for this reason;
     these two were left behind. */
  const got = await requireRender();
  if (got.response) return got.response;
  const quoteOnly = (await req.clone().json().catch(() => ({}))).quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  const run = async () => {
  try {
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const n = Number(body.scene);
  if (!projectId || !Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Which scene?" }, { status: 400 });
  const t = await getTreatment(projectId);
  const scene = t?.scenes.find((s) => s.n === n);
  if (!t || !scene) return NextResponse.json({ error: "No such scene." }, { status: 404 });
  if (!gatewayReachable() && !vendorKey('openai')) return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });

  const castNames = (await listCast(projectId)).map((c) => c.name);
  const effort = requestEffort(body.effort);
  const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "shot");
  const hint = suggestEngine(`${scene.title} ${scene.prose}`);
  const user = [
    `LOGLINE: ${t.logline || "(none yet)"}`,
    Object.keys(t.setup).length ? `THE PRODUCTION'S SETUP (carry it unless the shot needs otherwise): ${specToPhrase(t.setup)}` : "",
    `CAST NAMES: ${castNames.length ? castNames.map((c) => `@${c}`).join(", ") : "(none)"}`,
    `SETUP ROWS AND THEIR VALUES:\n${setupVocabulary()}`,
    `SCENE ${n} — ${scene.title || "Untitled"} (${scene.secs}s):\n${scene.prose || "(empty)"}`,
    `THE RULE SAYS: ${hint.engine} (${hint.why}). Follow it unless a shot is clearly otherwise, and say why.`,
  ].filter(Boolean).join("\n\n");
  const input = { model, effort, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 2400, kind: "shots", mock: "shots" as const, createdBy: got.user.id, projectId };
  if (quoteOnly) return paidTextQuoteResponse(await quotePaidText(input));
  const result = await runPaidText({ ...input, maxCredits: requestMaxCredits(body.maxCredits, body.effort !== undefined) });
  const text = result.text;
  const costUsd = result.costUsd;
  const shots = shotsFromReply(text, castNames);
  if (!shots) return NextResponse.json({ error: `${model} answered, but not with shots. Try once more, or another model.` }, { status: 502 });

  const priced = shots.map((s) => ({ ...s, takeUsd: shotCostUsd(s.engine, s.planned) }));
  return NextResponse.json({ scene: n, shots: priced, sceneUsd: Math.round(priced.reduce((a, s) => a + s.takeUsd, 0) * 1000) / 1000, model, effort: effort ?? "auto", costUsd });
  } catch (error) { return paidTextFailure(error); }
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run);
});
