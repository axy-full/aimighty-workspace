import { NextResponse, type NextRequest } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import {
  getChat, patchChat, deleteChat, addUserMessage, runTurn, projectContext, requestEffort,
  type AgentMode,
} from "@/lib/atomik";
import { writerRulesByScope } from "@/lib/platformLayer";
import { effectiveRules } from "@/lib/rules";
import { withGenerationRequest, SpendReservationError } from "@/lib/generationRequests";
import { PaidTextError, paidTextQuoteScopeFailure, paidTextFailure, paidTextQuoteResponse, requestMaxCredits } from "@/lib/paidText";
import { cleanAttachments } from "@/lib/attachments";
import { connectedPlannerFor } from "@/lib/higgsfield-consumer/planner-service";

export const dynamic = "force-dynamic";
/* A bounded 270s provider attempt has enough time for reasoning before this route ends. */
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: NextRequest, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
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
  await patchChat(id, {
    title: typeof b.title === "string" ? b.title : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
    effort: requestEffort(b.effort),
    agentMode: b.agentMode === "ask" || b.agentMode === "auto" ? b.agentMode as AgentMode : undefined,
    projectId: b.projectId === undefined ? undefined : (b.projectId || null),
  });
  return NextResponse.json(await getChat(id));
  } catch (error) { return paidTextFailure(error); }
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
 * cannot cause a second paid attempt.
 */
export const POST = withTenant(async function POST(req: NextRequest, ctx: Ctx) {
  /* A turn is a paid call to the gateway, so this is a spending route and
     a read-only token has no business reaching it. requireUser accepts a
     bearer of ANY scope, which let a token minted to list renders run the
     planner and bill the workspace for it. */
  const got = await requireRender();
  if (got.response) return got.response;
  const quoteOnly = (await req.clone().json().catch(() => ({}))).quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  const run = async () => {
  const { id } = await ctx.params;

  const b = await req.json().catch(() => ({}));
  const text = String(b.text ?? "").trim().slice(0, 20000);
  if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const loaded = await getChat(id);
  if (!loaded) return NextResponse.json({ error: "That chat is gone." }, { status: 404 });

  try {
    const effort = requestEffort(b.effort);
    if (b.model !== undefined && (typeof b.model !== "string" || !b.model || b.model.length > 120))
      return NextResponse.json({ error: "Choose an available Atomik model." }, { status: 400 });
    const context = await projectContext(loaded.chat.projectId);
    const rules = writerRulesByScope(await effectiveRules());
    /* The owner's connected account: read-only context and priced proposals.
       The quote and the turn it prices see the same (cached) context. */
    const connected = await connectedPlannerFor(got.user, got.token, loaded.chat.projectId);
    if (quoteOnly) return paidTextQuoteResponse(await runTurn(id, { quoteOnly: true, context, model: b.model, effort, rules, connected,
      userMessage: { text, attachments: cleanAttachments(b.attachments) } }));
    const maxCredits = requestMaxCredits(b.maxCredits, b.effort !== undefined);
    await addUserMessage(id, text, cleanAttachments(b.attachments));
    await runTurn(id, { context, model: b.model, effort, maxCredits, rules, connected });
  } catch (e) {
    if (!quoteOnly) await patchChat(id, { status: "failed" });
    const known = e instanceof PaidTextError || e instanceof SpendReservationError;
    return NextResponse.json(
      { error: known ? e.message : "The planning request could not finish. Recover this request before starting another.", chat: await getChat(id) },
      { status: known ? e.status : 502 },
    );
  }
  return NextResponse.json(await getChat(id));
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run);
});
