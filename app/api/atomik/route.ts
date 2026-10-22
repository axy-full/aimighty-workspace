import { NextResponse, after, type NextRequest } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { admittedProjectOr, contextProjectOr } from "@/lib/draftProject";
import { currentTenant, runWithStore } from "@/lib/tenant";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { listChats, createChat, engines, runTurn, projectContext, VIEW_ONLY_INSTRUCTION, chatModeOf, memberChat } from "@/lib/atomik";
import { atomikEffortOptions } from "@/lib/atomik-reasoning";
import { cleanAttachments } from "@/lib/attachments";
import { effectiveRules } from "@/lib/rules";
import { writerRulesByScope } from "@/lib/platformLayer";
import { paidTextFailure, atomikQuoteResponse, paidTextQuoteScopeFailure } from "@/lib/paidText";
import { menuFor, type CatalogModel } from "@/lib/catalog";
import { plannerMemoryText } from "@/lib/atomikMemory";
import { plannerInputs, plannerPresetsStale, refreshPlannerPresets } from "@/lib/atomikLibrary";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";

/**
 * The chat list and the planner menu.
 *
 * Both in one response because the screen needs both to draw its first
 * frame, and the menu is a cached read of the gateway's catalogue rather
 * than a query — asking for it separately would cost a round trip to save
 * nothing.
 */

/** A coarse band, not a price.
 *
 *  Text pricing is per token, so a number here would be a rate nobody can
 *  turn into "what will this conversation cost me". Three bands answer the
 *  question people actually have, which is whether this planner is the
 *  cheap one or the expensive one. */
function band(m: CatalogModel): "Low cost" | "Medium cost" | "High cost" | "" {
  const p = m.pricing as Record<string, unknown> | null;
  const out = Number(p?.output);
  if (!Number.isFinite(out)) return "";
  const perM = out * 1e6;
  /* Cut where the models actually cluster, not on round numbers. Output
     rates run in three groups: the cheap open-weight planners land under
     $3, the mid-tier frontier models between there and $15, and only the
     top of each house is above. Tighter cuts put GLM at $2.20 and Kimi at
     $2.00 in different bands, which tells a reader nothing true. */
  return perM <= 3 ? "Low cost" : perM <= 15 ? "Medium cost" : "High cost";
}

/* No per-token price here. The gateway's rate is what the platform pays for
   a planner, and the menu is read by every workspace, credit ones included;
   the band says cheap or dear, and a turn's price is its quote, in credits. */
const shape = (m: CatalogModel) => ({
  id: m.id, name: m.name, owner: m.owner, released: m.released,
  description: m.description.slice(0, 120),
  band: band(m), efforts: atomikEffortOptions(m),
  vision: m.inputModalities?.includes("image") ?? false,
});

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
    /* No thinking model or effort on a chat a person is sent (lib/atomik › memberChat). The menu below is the picker's until the Thinking control replaces it. */
    chats: chats.map((chat) => memberChat(chat)),
    engines: eng,
    models: {
      featured: menu.featured.map(shape),
      rest: menu.rest.map(shape),
    },
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
