import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readBoundedText, RequestBodyError } from "@/lib/requestBody";
import { SkillTextError } from "@/lib/atomikSkillsText";
import { editSkill, getSkill, getSkillVersion, setSkillStatus } from "@/lib/atomikSkills";

export const dynamic = "force-dynamic";

/**
 * One Atomik skill (lib/atomikSkills.ts). Free, and for a signed-in person
 * only; a personal skill answers only its maker, as if it were not there.
 *
 *  GET    the skill and every version it has had
 *  GET    ?version=N   one version as it was saved (every earlier version stays readable)
 *  PATCH  {action:"edit", expectedVersion, …}   the next version; the one it follows is kept
 *  PATCH  {action:"archive"} / {action:"restore"}   hide it, or bring it back as it was; nothing is deleted
 */

type Ctx = { params: Promise<{ id: string }> };
const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });

function failure(error: unknown, fallback: string) {
  if (error instanceof SkillTextError) return reply({ error: error.message }, error.status);
  console.error("Atomik skill request failed");
  return reply({ error: fallback }, 500);
}

export const GET = withTenant(async (req: Request, ctx: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  try {
    const version = new URL(req.url).searchParams.get("version");
    if (version !== null) return reply({ version: await getSkillVersion(id, version, got.user.id) });
    return reply(await getSkill(id, got.user.id));
  } catch (error) { return failure(error, "This skill could not be loaded. Try again."); }
});

export const PATCH = withTenant(async (req: Request, ctx: Ctx) => {
  const got = await requireSession();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(await readBoundedText(req, 100_000));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestBodyError(400);
    body = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) return reply({ error: "That edit is too long to save." }, 413);
    return reply({ error: "Invalid request JSON." }, 400);
  }
  try {
    switch (body.action) {
      case "edit":
        return reply({ skill: await editSkill(id, {
          expectedVersion: body.expectedVersion, name: body.name, slug: body.slug, description: body.description,
          scope: body.scope, note: body.note, template: body.template,
        }, got.user.id) });
      case "archive":
        return reply({ skill: await setSkillStatus(id, "archived", got.user.id) });
      case "restore":
        return reply({ skill: await setSkillStatus(id, "active", got.user.id) });
      default:
        return reply({ error: "Choose edit, archive or restore." }, 400);
    }
  } catch (error) { return failure(error, "That change could not be saved. Try again."); }
}, { requireRequestScope: true });
