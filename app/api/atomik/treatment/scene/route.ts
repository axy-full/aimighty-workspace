import { mayReachProject } from "@/lib/draftProject";
import { isAgentId } from "@/lib/security/people-only";
import { languageReachable } from '@/lib/language-provider';
import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { now } from "@/lib/db";
import { getTreatment, sceneFromReply } from "@/lib/atomikDocs";
import { resolveModel } from "@/lib/atomik";
import { thinkingRun } from "@/lib/atomikThinking";
import { NO_MODEL_NAME, TreatmentWriterOff } from "@/lib/atomikModelPolicy";
import { specToPhrase } from "@/lib/studio";
import { creditsApply } from "@/lib/credits";
import { currentTenant } from "@/lib/tenant";

import { runPaidText, quotePaidText, atomikQuoteResponse, requestMaxCredits, paidTextQuoteScopeFailure, paidTextFailure } from "@/lib/paidText";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { tokenSpendRefusal } from "@/lib/tokenSpend";
import { withGenerationRequest, ANSWER_AFTER_MS } from "@/lib/generationRequests";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SYSTEM = [
  "You rewrite ONE scene of a film treatment for a production studio, in the voice of the treatment around it.",
  NO_MODEL_NAME,
  "You are given the logline, the shot setup the whole production carries, the other scenes' titles and lengths,",
  "and the scene to rewrite with its current title, length and prose. Keep what the scene is for; write it better:",
  "concrete, filmable, present tense, no camera jargon, no hype. Keep every @Name that is already there and invent no new people.",
  'Return ONLY a JSON object: {"title": string, "secs": number, "prose": string} — no prose outside it, no code fence.',
].join(" ");

/**
 * Regenerate one scene (brief 1.8): a proposal comes back, priced and
 * metered as text; nothing is written to the treatment here — the person
 * chooses to use it, so a human edit is never overwritten by a machine.
 *
 * A scene's words are the Treatment's prose, which the Treatment writer
 * writes and nothing else does (lib/atomikModelPolicy › treatmentWriter;
 * Amendment (iii) §E). With no writer set up it is refused before anything
 * is quoted, claimed or charged, in plain words and naming no model.
 */
export const POST = withTenant(async function POST(req: Request) {
  /* requireRender, not requireUser. This spends the platform's AI-Gateway
     credit, and requireUser accepts a bearer of ANY scope — including the
     read-only token /connect hands to MCP clients precisely because it
     "cannot bill". The identity and ideas routes were moved for this reason;
     these two were left behind. */
  const got = await requireRender();
  if (got.response) return got.response;
  /* The body, read now: the run may finish after its reply (answerAfterMs). */
  const body = await req.clone().json().catch(() => ({}));
  const quoteOnly = body?.quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  if (!quoteOnly) { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A token or an MCP client spends only with a ceiling and the quote it was approved at, as `maxCredits` (lib/tokenSpend.ts): refused before the request is claimed. */
  if (!quoteOnly) { const refused = tokenSpendRefusal({ maxCredits: body?.maxCredits }, got.token); if (refused) return refused; }
  /* The Treatment writer (lib/atomik › resolveModel, "treatment"), asked before the request is claimed: none set up, or none served, is refused with nothing quoted, claimed or charged. A model in the body is ignored. */
  let model: string;
  try { model = await resolveModel("auto", "treatment"); }
  catch (error) {
    if (error instanceof TreatmentWriterOff) return NextResponse.json({ error: error.message, code: "treatment_writer_off", charged: 0, nothingBilled: true }, { status: error.status });
    return paidTextFailure(error);
  }
  const thinking = await thinkingRun("treatment", model), effort = thinking.effort;
  const run = async () => {
  try {
  const projectId = String(body.projectId ?? "");
  const n = Number(body.n);
  if (!projectId || !Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Which scene?" }, { status: 400 });
  /* A private board is its owner's, and a shared one a teammate's to look at (lib/draftProject.ts): asked always, before the gateway or any reservation, and refused as a scene that is not there is. */
  const reach = await mayReachProject(isAgentId(got.user.id) ? null : got.user, projectId, "write");
  const t = await getTreatment(projectId);
  const scene = t?.scenes.find((s) => s.n === n);
  if (!t || !scene || !reach) return NextResponse.json({ error: "No such scene." }, { status: 404 });
  if (!languageReachable()) return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });

  const user = [
    `LOGLINE: ${t.logline || "(none yet)"}`,
    Object.keys(t.setup).length ? `SETUP: ${specToPhrase(t.setup)}` : "",
    `SCENES: ${t.scenes.map((s) => `${s.n}. ${s.title || "Untitled"} (${s.secs}s)`).join("; ")}`,
    `REWRITE SCENE ${n}:`, `title: ${scene.title || "(untitled)"}`, `secs: ${scene.secs}`, `prose: ${scene.prose || "(empty)"}`,
    typeof body.note === "string" && body.note.trim() ? `THE PERSON ASKS: ${body.note.trim().slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
  const input = { model, effort, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 900, kind: "scene", mock: "scene" as const, createdBy: got.user.id,
    /* Its model call's span (lib/modelTrace.ts): ids and settings only. */ trace: { site: "atomik.treatment_scene" as const, step: "scene", model, effort: effort ?? "auto" }, projectId };
  if (quoteOnly) return atomikQuoteResponse(await quotePaidText(input));
  /* A run of Atomik's thinking (or the Treatment writer) needs the ceiling its person approved on the quote, whatever the caller sent: refused before the run, nothing billed. */
  const result = await runPaidText({ ...input, maxCredits: requestMaxCredits(body.maxCredits, thinking.ours), ceilingRequired: thinking.ours });
  const out = sceneFromReply(result.text);
  if (!out) return NextResponse.json({ error: "The Treatment writer answered, but not with a scene. Try once more." }, { status: 502 });

  /* The writing in this workspace's unit: the credits the ledger billed, or the dollars a workspace on its own keys paid. Never the vendor's dollars to a workspace on credits. */
  const writing = creditsApply(currentTenant()?.workspace) ? { writingCredits: result.credits } : { costUsd: result.costUsd };
  /* Who wrote it is "atomik": the writer's model and effort stay on the server (Amendment (iii) §E: never disclosed). */
  return NextResponse.json({ scene: { ...out, n, by: "atomik", at: now() }, ...writing });
  } catch (error) { return paidTextFailure(error); }
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run, { answerAfterMs: ANSWER_AFTER_MS });
});
