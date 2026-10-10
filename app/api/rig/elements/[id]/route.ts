import { NextResponse } from "next/server";
import { requireUser, requireRender, withTenant } from "@/lib/auth";
import { db, ready, now } from "@/lib/db";
import { getElement, elementUsage, overridesOf, type ElementFull } from "@/lib/elements";
import { lockHistory, lockMaster, masterCheck, MasterLockError, unlockMaster, type LockBy } from "@/lib/masters";
import { requireTenant } from "@/lib/tenant";
import { publicActorEmail, SUPPORT_ACTOR } from "@/lib/platformOwnerPrivacy";
import { TeamCanvasError } from "@/lib/workbench/team-canvas";
import { MediaSourceError } from "@/lib/mediaBindings";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

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
     naming a Keyframes stage is one thing that consumes a port, not two.

     Classified from the ENGINE, case-insensitively, and only then from the
     name. The first pass tested `engine.includes("eleven")`, which is false
     for "ElevenLabs" — the label the product itself uses — so a stage named
     "VO" with that engine landed in `visual`, and because the audio line is
     only drawn when there IS an audio stage, the character's VOICE port
     disappeared from the card entirely while the same stage was claimed by
     FACE · HAIR · WARDROBE. A misclassification here is not a mislabel; it
     deletes a port from the one screen a swap is judged on. */
  const visual: string[] = [];
  const audio: string[] = [];
  const seen = new Set<string>();
  const isAudio = (engine: string, name: string) => {
    const e = engine.toLowerCase();
    if (/eleven|elevenlabs/.test(e)) return true;
    /* The name is a last resort, and only when the engine says nothing. An
       engine that names a picture model beats any word in the title: a
       lip-sync stage called "Voice sync" renders frames. */
    return e ? false : /\baudio\b|\bvoice\b|\bvo\b|\bsound\b|\bmusic\b|\bsfx\b/i.test(name);
  };
  for (const row of rs.rows) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r = row as any;
    const name = String(r.name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    (isAudio(String(r.engine ?? ""), name) ? audio : visual).push(name);
  }
  return { visual, audio };
}

export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const element = await getElement(id);
  if (!element) return NextResponse.json({ error: "No such element." }, { status: 404 });

  /* The Rig's Card Inspector: the master's lock, its history, and whether its source is still what the lock froze. */
  if (new URL(req.url).searchParams.get("view") === "lock") {
    const [history, check] = await Promise.all([lockHistory(id), masterCheck(id)]);
    return NextResponse.json({ element: lockSummary(element), history, check }, { headers: { "Cache-Control": "no-store" } });
  }

  const [usage, overrides, stages] = await Promise.all([
    elementUsage(id),
    overridesOf(id),
    stagesFor(id, element.projectId),
  ]);

  return NextResponse.json({ element, usage, overrides, stages });
});

const CARD_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** The Rig card a lock comes from: its production and the card's id. */
function canvasCard(value: unknown): { productionId: string; nodeId: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.productionId === "string" && CARD_ID.test(v.productionId) && typeof v.nodeId === "string" && CARD_ID.test(v.nodeId)
    ? { productionId: v.productionId, nodeId: v.nodeId }
    : null;
}

function lockSummary(element: Pick<ElementFull, "id" | "name" | "kind" | "projectId" | "locked" | "lockedAt">) {
  return { id: element.id, name: element.name, kind: element.kind, projectId: element.projectId, locked: element.locked, lockedAt: element.lockedAt };
}

/**
 * The lock: `{ locked, reason?, canvas?: { productionId, nodeId }, by? }`.
 *
 * Locking is free and anyone in the workspace may do it; Atomik's plan says so
 * (`by: "atomik"`) and is recorded as Atomik. From a Rig card (`canvas`), the
 * card becomes the master: it is mirrored into an element when it has none
 * (the id is then `new`), its source becomes the element's current version,
 * and the lock record lands on the card for everyone (lib/masters.ts).
 * Unlocking needs a signed-in admin and a reason; Atomik never unlocks. Every
 * lock and unlock is kept in the element's history.
 */
export const PUT = withTenant(async function PUT(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  await ready();

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
  const locked = body?.locked;
  if (typeof locked !== "boolean") {
    return NextResponse.json({ error: "Say whether it is locked." }, { status: 400 });
  }
  const canvas = canvasCard(body?.canvas);
  if (body?.canvas !== undefined && !canvas) return NextResponse.json({ error: "Name the card to lock." }, { status: 400 });
  /* A card's lock writes the team canvas: the same scope rule as any canvas edit. */
  if (canvas) {
    const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, true);
    if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  }
  const elementId = id === "new" ? null : id;
  if (!elementId && !(locked && canvas)) return NextResponse.json({ error: "No such element." }, { status: 404 });

  /* Spends nothing and re-renders nothing: a lock is a rule about what may
     change later, not a change itself. Who did it, when and (for an unlock)
     why are kept, because the brief's own line is that unlocking is explicit
     and logged. */
  /* Outside the house the platform owner is recorded as "Particl support", never by address or account id. */
  const email = (await publicActorEmail(requireTenant(), got.user)) ?? SUPPORT_ACTOR;
  const by: LockBy = {
    userId: got.user.id, name: got.user.name || email, email, admin: got.user.role === "admin",
    token: !!got.token, agent: body?.by === "atomik" ? { runId: null } : null,
  };
  try {
    const result = locked
      ? await lockMaster({ elementId, canvas }, by)
      : await unlockMaster({ elementId: elementId!, reason: body?.reason, canvas }, by);
    return NextResponse.json({
      ok: true, locked, unchanged: result.unchanged, by: email, at: now(),
      element: lockSummary(result.element), event: result.event, node: result.node, revision: result.revision, sha256: result.sha256,
    });
  } catch (error) {
    if (error instanceof MasterLockError || error instanceof TeamCanvasError) return NextResponse.json({ error: error.message }, { status: error.status });
    /* The card's picture is no longer in the library: nothing was locked. */
    if (error instanceof MediaSourceError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
});
