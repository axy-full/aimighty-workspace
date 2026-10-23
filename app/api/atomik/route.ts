import { NextResponse, after, type NextRequest } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { admittedProjectOr, contextProjectOr } from "@/lib/draftProject";
import { currentTenant, runWithStore } from "@/lib/tenant";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { listChats, createChat, engines, runTurn, projectContext, VIEW_ONLY_INSTRUCTION, chatModeOf, memberChat } from "@/lib/atomik";
import { cleanAttachments } from "@/lib/attachments";
import { effectiveRules } from "@/lib/rules";
import { writerRulesByScope } from "@/lib/platformLayer";
import { paidTextFailure, atomikQuoteResponse, paidTextQuoteScopeFailure } from "@/lib/paidText";
import { menuFor } from "@/lib/catalog";
import { plannerMemoryText } from "@/lib/atomikMemory";
import { plannerInputs, plannerPresetsStale, refreshPlannerPresets } from "@/lib/atomikLibrary";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";

/**
 * The chat list, the engines, and whether Atomik's thinking is connected.
 *
 * No thinking model is listed: the models behind High · Medium · Low are the deployment's and are never
 * shown to a member (docs/atomik-model-policy.md). `configured` says only whether any of them is served,
 * so the page knows Thinking is available; the picker draws nothing without a list.
 */

export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;

  /* Particl's own engines only: Atomik never plans on a signed-in account. */
  const [chats, menu, eng] = await Promise.all([listChats(got.user.id), menuFor("planner"), engines()]);
  /* The Marketing Studio presets the planner may name are the ones this key listed within the hour. When
     none are, the catalogue is read after this response (free, non-generating), never inside a planning quote. */
  if (await plannerPresetsStale().catch(() => false)) {
    const store = currentTenant()!;
    after(await reserveRecoveryContinuation("after-response", () => runWithStore(store, refreshPlannerPresets)));
  }
  return NextResponse.json({
    /* No thinking model or effort on a chat a person is sent (lib/atomik › memberChat), and no menu of them: only whether one is served. */
    chats: chats.map((chat) => memberChat(chat)),
    engines: eng,
    configured: menu.featured.length + menu.rest.length > 0,
  });
});

export const POST = withTenant(async function POST(req: NextRequest) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  try {
  if (body.quoteOnly === true) {
    const auth = await requireRender();
    if (auth.response) return auth.response;
    const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure;
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 20000) : "";
    if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });
    /* Two projects, asked of this person alone (lib/draftProject.ts): the one they may READ (their own board, a teammate's shared board) feeds the quote's context and memory reads; the one they may FILE into is what the turn spends against, so a quote prices it the same. Someone else's private board gives neither. */
    const asked = typeof body.projectId === "string" ? body.projectId : null;
    const readProject = await contextProjectOr(got.user, asked);
    const projectId = await admittedProjectOr(got.user, asked);
    /* The project's library and presets for library steps, read as the turn will read them. */
    const inputs = await plannerInputs(auth.user.id, projectId);
    const viewOnly = Boolean(readProject && !projectId);
    /* The model and effort are the workspace's Thinking setting (lib/atomikThinking.ts): a sent model or effort is not a choice, and is ignored. */
    return atomikQuoteResponse(await runTurn(null, { quoteOnly: true, projectId, viewOnly,
      context: [viewOnly ? VIEW_ONLY_INSTRUCTION : "", await projectContext(readProject)].filter(Boolean).join("\n\n"), rules: writerRulesByScope(await effectiveRules()),
      /* The team's memory, read as the turn will read it: the quote prices the same message. */
      memory: await plannerMemoryText({ projectId: readProject, query: text, viewer: got.user.id }).catch(() => ""),
      library: inputs.library, presets: inputs.presets,
      userMessage: { text, attachments: cleanAttachments(body.attachments) } }));
  }
  /* The sample workspace has no Atomik chat: its turns would spend. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  const id = await createChat({
    userId: got.user.id,
    /* The project a chat keeps: one its maker may READ (their own board, a teammate's shared board, any project that is not a private board); a private board of someone else's, or an id that is none, is stored as no project (the same answer for both). Spending, step filing and memory writes need more, and are decided separately (admission, and the turn). */
    projectId: await contextProjectOr(got.user, typeof body.projectId === "string" ? body.projectId : null),
    /* A new chat follows the Thinking setting; each turn stores what it ran. A sent model or effort is ignored. */
    model: "auto",
    /* "auto" from an older caller is accepted and stored as "ask": no Auto since 20 Oct 2026. */
    agentMode: chatModeOf(body.agentMode),
  });
  return NextResponse.json({ id });
  } catch (error) {
    return paidTextFailure(error);
  }
});
