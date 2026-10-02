import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { SkillTextError } from "@/lib/atomikSkillsText";
import { draftFromRun, listSkills, savableRuns, saveSkillFromRun } from "@/lib/atomikSkills";

export const dynamic = "force-dynamic";

/**
 * Atomik skills (lib/atomikSkills.ts): runs saved to be run again. Free —
 * nothing here calls a model or a vendor — and for a signed-in person only:
 * an API token neither reads nor writes them.
 *
 *  GET  ?status=archived&q=   the skills this person may see: the workspace's and their own
 *  GET  ?runs=1&projectId=    the Atomik runs that could be saved
 *  POST {action:"draft"}      the Save as skill form, filled from a run (read-only)
 *  POST {action:"save"}       a run saved as a skill: its version 1
 */

const BODY_BYTES = 64_000;

const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

function skillFailure(error: unknown, fallback: string) {
  if (error instanceof SkillTextError) {
    const problems = (error as SkillTextError & { problems?: unknown[] }).problems;
    return reply({ error: error.message, ...(problems?.length ? { problems } : {}) }, error.status);
  }
  console.error("Atomik skills request failed");
  return reply({ error: fallback }, 500);
}

export const GET = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("runs") === "1") return reply({ runs: await savableRuns(url.searchParams.get("projectId")) });
    return reply({ skills: await listSkills({ status: url.searchParams.get("status"), query: url.searchParams.get("q") }, got.user.id) });
  } catch (error) { return skillFailure(error, "Skills could not be loaded. Try again."); }
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireSession();
  if (got.response) return got.response;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, BODY_BYTES));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: "That is too much to save at once." }, 413);
    return reply({ error: "Invalid request JSON." }, 400);
  }
  try {
    switch (body.action) {
      case "draft":
        return reply({ draft: await draftFromRun(body.chatId) });
      case "save":
        return reply({ skill: await saveSkillFromRun({
          chatId: body.chatId, stepIds: body.stepIds, parameters: body.parameters,
          name: body.name, slug: body.slug, description: body.description, scope: body.scope,
        }, got.user.id) }, 201);
      default:
        return reply({ error: "Choose draft or save." }, 400);
    }
  } catch (error) { return skillFailure(error, "That skill could not be saved. Try again."); }
}, { requireRequestScope: true });
