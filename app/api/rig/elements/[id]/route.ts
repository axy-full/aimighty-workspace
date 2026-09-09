import { NextResponse } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { db, ready, now } from "@/lib/db";
import { getElement, elementUsage, overridesOf, setElementLock } from "@/lib/elements";

/**
 * One element and everything it reaches (brief 3, surface 2b). The id is the
 * element's.
 *
 * GET answers the question a swap has to be able to answer first: what uses
 * this, on which version, and what has already been made with it. PUT is the
 * lock, and only the lock — changing which version is current goes through
 * `/api/rig/attributes/[id]/current`, which refuses without a decision about
 * the takes that already exist. Two routes because they are two acts: one
 * costs nothing and one prices a re-render.
 *
 * Workspace-scoped throughout: every read is db(), which is the workspace in
 * scope and throws when there is none.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The stages this production actually runs, split by what they consume.
 *
 * Named from the recipe rather than hard-coded, because the stages a
 * workspace runs are its own: telling a producer their character's voice is
 * wired into an Audio stage their recipe does not have would be a diagram of
 * somebody else's production.
 */
async function stagesFor(elementId: string, projectId: string | null): Promise<{ visual: string[]; audio: string[] }> {
  /* A SHARED element belongs to no production, so asking its own project for
     stages returned nothing and WIRED INTO was empty for every element the
     workspace shares — which is most of the interesting ones. The honest
     answer for a shared element is the stages of the productions that
     actually bind it.
 
     Draft recipes are included on purpose. `recipes.draft` defaults to 1, so
     filtering them out empties this card for every production that has not
     explicitly published a recipe — which today is all of them. A draft
     recipe is still what the production intends to run, and this card is
     saying what consumes a port, not promising a run. */
  const rs = projectId
    ? await db().execute({
        sql: `SELECT s.name, s.engine FROM recipe_stages s
              JOIN recipes r ON r.id = s.recipe_id
              WHERE r.project_id = ? AND s.kind = 'render'
              ORDER BY s.num`,
        args: [projectId],
      })
    : await db().execute({
        sql: `SELECT s.name, s.engine FROM recipe_stages s
              JOIN recipes r ON r.id = s.recipe_id
              WHERE s.kind = 'render'
                AND r.project_id IN (SELECT DISTINCT project_id FROM bindings
                                     WHERE element_id = ? AND project_id IS NOT NULL)
              ORDER BY s.num`,
        args: [elementId],
      });
  /* Deduplicated: a production can hold more than one recipe, and two of them
     naming a Keyframes stage is one thing that consumes a port, not two. */
  const visual: string[] = [];
  const audio: string[] = [];
  const seen = new Set<string>();
  for (const row of rs.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = row as any;
    const name = String(r.name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    (String(r.engine ?? "").includes("eleven") || /audio|voice|sound/i.test(name) ? audio : visual).push(name);
  }
  return { visual, audio };
}

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const element = await getElement(id);
  if (!element) return NextResponse.json({ error: "No such element." }, { status: 404 });

  const [usage, overrides, stages] = await Promise.all([
    elementUsage(id),
    overridesOf(id),
    stagesFor(id, element.projectId),
  ]);

  return NextResponse.json({ element, usage, overrides, stages });
});

export const PUT = withTenant(async function PUT(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const element = await getElement(id);
  if (!element) return NextResponse.json({ error: "No such element." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const locked = (body as any)?.locked;
  if (typeof locked !== "boolean") {
    return NextResponse.json({ error: "Say whether it is locked." }, { status: 400 });
  }
  if (locked === element.locked) return NextResponse.json({ ok: true, unchanged: true });

  /* Spends nothing and re-renders nothing: a lock is a rule about what may
     change later, not a change itself. Who did it and when are kept, because
     the brief's own line is that unlocking is explicit and logged. */
  await setElementLock(id, locked, got.user.email);
  return NextResponse.json({ ok: true, locked, by: got.user.email, at: now() });
});
