import { NextResponse, type NextRequest } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import {
  getChat, patchChat, deleteChat, addUserMessage, runTurn, projectContext,
  type AgentMode,
} from "@/lib/atomik";
import { writerRulesByScope } from "@/lib/platformLayer";
import { effectiveRules } from "@/lib/rules";
import { cleanAttachments } from "@/lib/attachments";

export const dynamic = "force-dynamic";
/* A turn is a model call with a 180s ceiling of its own, so this route needs
   the same headroom the render routes get. */
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
  await patchChat(id, {
    title: typeof b.title === "string" ? b.title : undefined,
    model: typeof b.model === "string" ? b.model : undefined,
    agentMode: b.agentMode === "ask" || b.agentMode === "auto" ? b.agentMode as AgentMode : undefined,
    projectId: b.projectId === undefined ? undefined : (b.projectId || null),
  });
  return NextResponse.json(await getChat(id));
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
 * The turn runs inside the request rather than on a queue. A planning call
 * is seconds, not minutes, and the person is watching the composer — moving
 * it to a worker would buy durability for the one part of this system that
 * costs almost nothing to repeat, at the price of never being able to show
 * them what went wrong.
 */
export const POST = withTenant(async function POST(req: NextRequest, ctx: Ctx) {
  /* A turn is a paid call to the gateway, so this is a spending route and
     a read-only token has no business reaching it. requireUser accepts a
     bearer of ANY scope, which let a token minted to list renders run the
     planner and bill the workspace for it. */
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await ctx.params;

  const b = await req.json().catch(() => ({}));
  const text = String(b.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const loaded = await getChat(id);
  if (!loaded) return NextResponse.json({ error: "That chat is gone." }, { status: 404 });

  await addUserMessage(id, text, cleanAttachments(b.attachments));
  try {
    const context = await projectContext(loaded.chat.projectId);
    await runTurn(id, { context, rules: writerRulesByScope(await effectiveRules()) });
  } catch (e) {
    await patchChat(id, { status: "failed" });
    return NextResponse.json(
      { error: (e as Error).message, chat: await getChat(id) },
      { status: 502 },
    );
  }
  return NextResponse.json(await getChat(id));
});
