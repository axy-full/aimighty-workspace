import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { ready } from "@/lib/db";
import { nameFromBrief } from "@/components/graphite/home/home-model";
import { boardFromInput } from "@/lib/v12/tools/create-board";
import { projectSchema } from "@/lib/workbench/studio-schema";
import { saveDraft, workbenchReady } from "@/lib/workbench/records";

export const dynamic = "force-dynamic";

/**
 * `create_board` (lib/v12/tools/create-board.ts): makes a board for whoever calls it, as Home's "+ New project" does (the same builder, the
 * same saved draft). Free: nothing is reserved, called or billed. A person, or a token with the render scope; a read-only token is refused.
 * The board is the caller's own (a draft is private to its owner until they share it).
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const built = boardFromInput(body, nameFromBrief);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
  const parsed = projectSchema.safeParse(built.project);
  if (!parsed.success) return NextResponse.json({ error: "The board could not be made." }, { status: 400 });
  await ready();
  await workbenchReady();
  try {
    const saved = await saveDraft(got.user.id, built.project, 0);
    return NextResponse.json({ id: built.project.id, name: built.project.name, ...saved });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The board could not be made." }, { status: 409 });
  }
});
