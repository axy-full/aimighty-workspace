import { admittedProjectOr, contextProjectOr } from "@/lib/draftProject";
import { NextResponse, type NextRequest } from "next/server";
import { TextNotSentError } from "@/lib/textDirect";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import {
  getChat, patchChat, clearChatProject, deleteChat, VIEW_ONLY_INSTRUCTION, addUserMessage, runTurn, projectContext, reconcileRunningSteps,
  chatModeOf,
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
import { tokenSpendRefusal } from "@/lib/tokenSpend";
import { CHAT_GONE, chatIsMine } from "@/lib/atomikAccess";

export const dynamic = "force-dynamic";
/* A bounded 270s provider attempt has enough time for reasoning before this route ends. */
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  /* A chat is its person's (lib/atomikAccess.ts): to anyone else it is gone. */
  if (!(await chatIsMine(id, got.user))) return NextResponse.json({ error: CHAT_GONE }, { status: 404 });
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
  /* Someone else's chat answers as a thread that is not there does (lib/atomikAccess.ts). */
  if (!(await chatIsMine(id, got.user))) return NextResponse.json({ error: "That thread is gone." }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  try {
  /* A thread is renamed, archived or restored (lib/atomikThreads.ts). None of it is activity, none of it
     spends, and archiving keeps everything in the thread. */
  if (typeof b.title === "string") await renameThread(id, b.title);
  if (typeof b.archived === "boolean") await (b.archived ? archiveThread(id, got.user.id) : restoreThread(id));
  /* A model or effort in the body is not saved: every turn runs the workspace's Thinking setting (lib/atomikThinking.ts). */
  await patchChat(id, {
    /* "ask", or "auto" from an older caller, is stored as "ask": no Auto since 20 Oct 2026. */
    agentMode: b.agentMode === "ask" || b.agentMode === "auto" ? chatModeOf(b.agentMode) : undefined,
    /* As at creation: only a project this person may read is kept; anything else clears it. */
    projectId: b.projectId === undefined ? undefined : await contextProjectOr(got.user, typeof b.projectId === "string" ? b.projectId : null),
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
  /* Someone else's chat is deleted as an unknown one is: nothing happens (lib/atomikAccess.ts). */
  if (!(await chatIsMine(id, got.user))) return NextResponse.json({ ok: true });
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
  /* A token or an MCP client spends only with a ceiling and the quote it was approved at, as `maxCredits` (lib/tokenSpend.ts): refused before the request is claimed. */
  if (!quoteOnly) { const refused = tokenSpendRefusal({ maxCredits: b?.maxCredits }, got.token); if (refused) return refused; }
  /* A turn in someone else's chat is a paid planning call on it: the chat is gone to anyone but its person, before anything is quoted or claimed (asked after the refusals that do not depend on the chat). */
  if (!(await chatIsMine(id, got.user))) return NextResponse.json({ error: CHAT_GONE }, { status: 404 });
  const run = async () => {
  const text = String(b.text ?? "").trim().slice(0, 20000);
  if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const loaded = await getChat(id);
  if (!loaded) return NextResponse.json({ error: "That chat is gone." }, { status: 404 });
  /* An archived thread is hidden: nothing is planned in it, or paid for, until it is restored. */
  if (!quoteOnly && loaded.chat.archivedAt != null) return NextResponse.json({ error: ARCHIVED_NOTE, chat: loaded }, { status: 409 });

  try {
    /* The turn's model and effort are the workspace's Thinking setting (lib/atomikThinking.ts): a model or effort in the body
       (an older page echoes the quote's back) is ignored, never refused. */
    /* Two questions, asked of this person alone (an admin is no exception here), before anything is reserved (lib/draftProject.ts): the project they may READ (their own board, a teammate's shared
       board) feeds the model's CONTEXT only; the project they may FILE into (their own board, any project that is not a private board) is the one a turn spends against, proposes and prices steps
       for, and writes memory under. Someone else's private board gives neither. The chat's own project is dropped only when it is not even readable. */
    const readProject = await contextProjectOr(got.user, loaded.chat.projectId);
    const projectId = await admittedProjectOr(got.user, loaded.chat.projectId);
    if (!quoteOnly && loaded.chat.projectId && !readProject) await clearChatProject(id, loaded.chat.projectId);
    /* A board they may read but not file into (a teammate's shared board): the planner is told, and proposes no renders there (lib/atomik.ts). */
    const viewOnly = Boolean(readProject && !projectId);
    const context = [viewOnly ? VIEW_ONLY_INSTRUCTION : "", await projectContext(readProject)].filter(Boolean).join("\n\n");
    /* The team's memory for this project (lib/atomikMemory): ranked and small, never money. The quote and the turn read it alike. */
    const memory = await plannerMemoryText({ projectId: readProject, query: text, viewer: got.user.id }).catch(() => "");
    const rules = writerRulesByScope(await effectiveRules());
    /* This person's view of the project's library, for library steps (lib/atomikLibrary.ts): the quote and the turn read the same. */
    const inputs = await plannerInputs(got.user.id, projectId);
    if (quoteOnly) return paidTextQuoteResponse(await runTurn(id, { quoteOnly: true, projectId, viewOnly, context, memory, rules,
      library: inputs.library, presets: inputs.presets,
      userMessage: { text, attachments: cleanAttachments(b.attachments) } }));
    /* A sent effort asks for the approved ceiling, as before, before the message is saved. The turn thinks at the setting's effort either
       way; without an approved ceiling it keeps the older safety cap (lib/paidText.ts textRequestEstimate). */
    const maxCredits = requestMaxCredits(b.maxCredits, b.effort !== undefined);
    await addUserMessage(id, text, cleanAttachments(b.attachments));
    /* A library step is proposed only at a price: the admission quote, as this person, for its exact render. */
    await runTurn(id, { projectId, viewOnly, context, memory, maxCredits, ceilingRequired: b.effort !== undefined, rules,
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
