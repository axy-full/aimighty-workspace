import { NextResponse, after, type NextRequest } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { currentTenant, runWithStore } from "@/lib/tenant";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { listChats, createChat, engines, requestEffort, runTurn, projectContext, type AgentMode } from "@/lib/atomik";
import { atomikEffortOptions } from "@/lib/atomik-reasoning";
import { cleanAttachments } from "@/lib/attachments";
import { effectiveRules } from "@/lib/rules";
import { writerRulesByScope } from "@/lib/platformLayer";
import { paidTextFailure, paidTextQuoteResponse, paidTextQuoteScopeFailure } from "@/lib/paidText";
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
  const [chats, menu, eng] = await Promise.all([listChats(), menuFor("planner"), engines()]);
  /* The Marketing Studio presets the planner may name are the ones this key listed within the hour. When
     none are, the catalogue is read after this response (free, non-generating), never inside a planning quote. */
  if (await plannerPresetsStale().catch(() => false)) {
    const store = currentTenant()!;
    after(await reserveRecoveryContinuation("after-response", () => runWithStore(store, refreshPlannerPresets)));
  }
  return NextResponse.json({
    chats,
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
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    /* The project's library and presets for library steps, read as the turn will read them. */
    const inputs = await plannerInputs(auth.user.id, projectId);
    return paidTextQuoteResponse(await runTurn(null, { quoteOnly: true, projectId,
      model: typeof body.model === "string" ? body.model : "auto", effort: requestEffort(body.effort),
      context: await projectContext(projectId), rules: writerRulesByScope(await effectiveRules()),
      /* The team's memory, read as the turn will read it: the quote prices the same message. */
      memory: await plannerMemoryText({ projectId, query: text }).catch(() => ""),
      library: inputs.library, presets: inputs.presets,
      userMessage: { text, attachments: cleanAttachments(body.attachments) } }));
  }
  /* The sample workspace has no Atomik chat: its turns would spend. A quote still answers. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  const id = await createChat({
    userId: got.user.id,
    projectId: typeof body.projectId === "string" ? body.projectId : null,
    model: typeof body.model === "string" && body.model ? body.model : "auto",
    effort: requestEffort(body.effort),
    agentMode: body.agentMode === "auto" ? "auto" : ("ask" as AgentMode),
  });
  return NextResponse.json({ id });
  } catch (error) {
    return paidTextFailure(error);
  }
});
