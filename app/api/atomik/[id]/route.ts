import { NextResponse, type NextRequest } from "next/server";
import { TextNotSentError } from "@/lib/textDirect";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import {
  getChat, patchChat, deleteChat, addUserMessage, runTurn, projectContext, requestEffort, reconcileRunningSteps,
  type AgentMode,
} from "@/lib/atomik";
import { writerRulesByScope } from "@/lib/platformLayer";
import { effectiveRules } from "@/lib/rules";
import { withGenerationRequest, SpendReservationError, ANSWER_AFTER_MS } from "@/lib/generationRequests";
import { PaidTextError, paidTextQuoteScopeFailure, paidTextFailure, paidTextQuoteResponse, requestMaxCredits } from "@/lib/paidText";
import { cleanAttachments } from "@/lib/attachments";
import { plannerMemoryText } from "@/lib/atomikMemory";
import { plannerInputs, priceKeyStep } from "@/lib/atomikLibrary";
import { ARCHIVED_NOTE, ThreadError, archiveThread, renameThread, restoreThread } from "@/lib/atomikThreads";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
/* A bounded 270s provider attempt has enough time for reasoning before this route ends. */
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  /* Reading the plan settles any step whose approval was cut off mid-way. */
  await reconcileRunningSteps(id);
  const loaded = await getChat(id);
  if (!loaded) return NextResponse.json({ error: "That chat is gone." }, { status: 404 });
  return NextResponse.json(loaded);
});

export const PATCH = withTenant(async function PATCH(req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  try {
  /* A thread is renamed, archived or restored (lib/atomikThreads.ts). None of it is activity, none of it
     spends, and archiving keeps everything in the thread. */
  if (typeof b.title === "string") await renameThread(id, b.title);
  if (typeof b.archived === "boolean") await (b.archived ? archiveThread(id, got.user.id) : restoreThread(id));
  await patchChat(id, {
    model: typeof b.model === "string" ? b.model : undefined,
    effort: requestEffort(b.effort),
    agentMode: b.agentMode === "ask" || b.agentMode === "auto" ? b.agentMode as AgentMode : undefined,
    projectId: b.projectId === undefined ? undefined : (b.projectId || null),
  });
  return NextResponse.json(await getChat(id));
  } catch (error) {
    if (error instanceof ThreadError) return NextResponse.json({ error: error.message }, { status: error.status });
    return paidTextFailure(error);
  }
});

export const DELETE = withTenant(async function DELETE(_req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  await deleteChat(id);
  return NextResponse.json({ ok: true });
});

/**
 * Say something, and let the agent answer.
 *
 * The turn runs inside the request. Its durable request claim and paid
 * reservation are saved before submission, so an interrupted response
 * cannot cause a second paid attempt. A turn still thinking after
 * ANSWER_AFTER_MS is answered "still being accepted" and finishes after the
 * reply; the same request sent again is answered with its saved reply.
 */
export const POST = withTenant(async function POST(req: NextRequest, ctx: Ctx) {
  /* A turn is a paid call to the gateway, so this is a spending route and
     a read-only token has no business reaching it. requireUser accepts a
     bearer of ANY scope, which let a token minted to list renders run the
     planner and bill the workspace for it. */
  const got = await requireRender();
  if (got.response) return got.response;
  /* Everything the turn reads from the request, read now: it may finish after its reply (answerAfterMs). */
  const b = await req.clone().json().catch(() => ({}));
  const { id } = await ctx.params;
  const quoteOnly = b?.quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  if (!quoteOnly) { const off = await sampleWorkspaceOff(); if (off) return off; }
  const run = async () => {
  const text = String(b.text ?? "").trim().slice(0, 20000);
  if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const loaded = await getChat(id);
  if (!loaded) return NextResponse.json({ error: "That chat is gone." }, { status: 404 });
  /* An archived thread is hidden: nothing is planned in it, or paid for, until it is restored. */
  if (!quoteOnly && loaded.chat.archivedAt != null) return NextResponse.json({ error: ARCHIVED_NOTE, chat: loaded }, { status: 409 });

  try {
    const effort = requestEffort(b.effort);
    if (b.model !== undefined && (typeof b.model !== "string" || !b.model || b.model.length > 120))
      return NextResponse.json({ error: "Choose an available Atomik model." }, { status: 400 });
    const context = await projectContext(loaded.chat.projectId);
    /* The team's memory for this project (lib/atomikMemory): ranked and small, never money. The quote and the turn read it alike. */
    const memory = await plannerMemoryText({ projectId: loaded.chat.projectId, query: text }).catch(() => "");
    const rules = writerRulesByScope(await effectiveRules());
    /* This person's view of the project's library, for library steps (lib/atomikLibrary.ts): the quote and the turn read the same. */
    const inputs = await plannerInputs(got.user.id, loaded.chat.projectId);
    if (quoteOnly) return paidTextQuoteResponse(await runTurn(id, { quoteOnly: true, context, memory, model: b.model, effort, rules,
      library: inputs.library, presets: inputs.presets,
      userMessage: { text, attachments: cleanAttachments(b.attachments) } }));
    const maxCredits = requestMaxCredits(b.maxCredits, b.effort !== undefined);
    await addUserMessage(id, text, cleanAttachments(b.attachments));
    /* A library step is proposed only at a price: the admission quote, as this person, for its exact render. */
    await runTurn(id, { context, memory, model: b.model, effort, maxCredits, rules,
      library: inputs.library, presets: inputs.presets, workbenchProjectId: inputs.studioProjectId,
      priceKeyStep: (body) => priceKeyStep(body, got) });
  } catch (e) {
    if (!quoteOnly) await patchChat(id, { status: "failed" });
    const known = e instanceof PaidTextError || e instanceof SpendReservationError || e instanceof TextNotSentError;
    return NextResponse.json(
      { error: known ? e.message : "The planning request could not finish. Recover this request before starting another.", chat: await getChat(id) },
      { status: known ? e.status : 502 },
    );
  }
  return NextResponse.json(await getChat(id));
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run, { answerAfterMs: ANSWER_AFTER_MS });
});
