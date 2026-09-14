import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { now } from "@/lib/db";
import { getTreatment, sceneFromReply } from "@/lib/atomikDocs";
import { resolveModel } from "@/lib/atomik";
import { gatewayReachable } from "@/lib/gateway";
import { specToPhrase } from "@/lib/studio";

import { runPaidText, paidTextFailure } from "@/lib/paidText";
import { withGenerationRequest } from "@/lib/generationRequests";

export const dynamic = "force-dynamic";

const SYSTEM = [
  "You rewrite ONE scene of a film treatment for a production studio, in the voice of the treatment around it.",
  "You are given the logline, the shot setup the whole production carries, the other scenes' titles and lengths,",
  "and the scene to rewrite with its current title, length and prose. Keep what the scene is for; write it better:",
  "concrete, filmable, present tense, no camera jargon, no hype. Keep every @Name that is already there and invent no new people.",
  'Return ONLY a JSON object: {"title": string, "secs": number, "prose": string} — no prose outside it, no code fence.',
].join(" ");

/**
 * Regenerate one scene (brief 1.8): a proposal comes back, priced and
 * metered as text; nothing is written to the treatment here — the person
 * chooses to use it, so a human edit is never overwritten by a machine.
 */
export const POST = withTenant(async function POST(req: Request) {
  /* requireRender, not requireUser. This spends the platform's AI-Gateway
     credit, and requireUser accepts a bearer of ANY scope — including the
     read-only token /connect hands to MCP clients precisely because it
     "cannot bill". The identity and ideas routes were moved for this reason;
     these two were left behind. */
  const got = await requireRender();
  if (got.response) return got.response;
  return withGenerationRequest(req, got.user.id, async () => {
  try {
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const n = Number(body.n);
  if (!projectId || !Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Which scene?" }, { status: 400 });
  const t = await getTreatment(projectId);
  const scene = t?.scenes.find((s) => s.n === n);
  if (!t || !scene) return NextResponse.json({ error: "No such scene." }, { status: 404 });
  if (!gatewayReachable()) return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });

  const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "idea");
  const user = [
    `LOGLINE: ${t.logline || "(none yet)"}`,
    Object.keys(t.setup).length ? `SETUP: ${specToPhrase(t.setup)}` : "",
    `SCENES: ${t.scenes.map((s) => `${s.n}. ${s.title || "Untitled"} (${s.secs}s)`).join("; ")}`,
    `REWRITE SCENE ${n}:`, `title: ${scene.title || "(untitled)"}`, `secs: ${scene.secs}`, `prose: ${scene.prose || "(empty)"}`,
    typeof body.note === "string" && body.note.trim() ? `THE PERSON ASKS: ${body.note.trim().slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
  const result = await runPaidText({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 900, kind: "scene", mock: "scene", createdBy: got.user.id, projectId });
  const text = result.text;
  const costUsd = result.costUsd;
  const out = sceneFromReply(text);
  if (!out) return NextResponse.json({ error: `${model} answered, but not with a scene. Try once more, or another model.` }, { status: 502 });

  return NextResponse.json({ scene: { ...out, n, by: model, at: now() }, model, costUsd });
  } catch (error) { return paidTextFailure(error); }
  });
});
