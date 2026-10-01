import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { SkillTextError } from "@/lib/atomikSkillsText";
import { runSkill } from "@/lib/atomikSkills";

export const dynamic = "force-dynamic";

/**
 * Run an Atomik skill (lib/atomikSkills.ts › runSkill): its parameters filled
 * in and its steps filed in an Atomik chat as proposals, each priced. Free in
 * itself: no model plans it and nothing is rendered or charged here. Each
 * step waits at its checkpoint for a live quote and a person's Continue.
 *
 *  POST {values, engines, dryRun:true}          the preview: filled steps, estimates, engines that need a choice
 *  POST {values, engines, chatId | projectId}   the plan, filed; 409 with `problems` while an engine needs a choice
 */

type Ctx = { params: Promise<{ id: string }> };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

export const POST = withTenant(async (req: Request, ctx: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, 16_000));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: "Those parameters are too long." }, 413);
    return reply({ error: "Invalid request JSON." }, 400);
  }
  try {
    const result = await runSkill(id, {
      values: body.values, engines: body.engines, chatId: body.chatId, projectId: body.projectId, dryRun: body.dryRun === true,
    }, got.user.id);
    return reply(body.dryRun === true ? { preview: result } : { run: result }, body.dryRun === true ? 200 : 201);
  } catch (error) {
    if (error instanceof SkillTextError) {
      const problems = (error as SkillTextError & { problems?: unknown[] }).problems;
      return reply({ error: error.message, ...(problems?.length ? { problems } : {}) }, error.status);
    }
    console.error("Atomik skill run failed");
    return reply({ error: "The skill could not be planned. Try again." }, 500);
  }
}, { requireRequestScope: true });
