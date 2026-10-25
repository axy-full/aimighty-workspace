import { heldBoardsProductionId, heldBoardsProjectId, isDraftProject, mayReachProject, ownsDraftProject } from "@/lib/draftProject";
import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { archiveDeleteStatements, archiveTransaction, type ArchiveStep } from "@/lib/archive";
import { effectiveCapRow, setOwnCap, unlockAtCap, workspaceBudget } from "@/lib/caps";
import { creditsApply } from "@/lib/credits";
import { requireTenant } from "@/lib/tenant";
import { NOT_YOURS, mayChangeProject } from "@/lib/workAccess";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * One project, read from its own row. The list (GET /api/projects) is memoised
 * for 15 seconds per server instance, so a project made a moment ago can be
 * missing from it on another instance; a page asks here before it says a
 * project does not exist. An archived project has left the table, and is 404.
 */
export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const rs = await db().execute({
    sql: `SELECT id, name, description, code, category, cap_usd, cap_credits, cap_unlocked, production_id FROM projects WHERE id = ? LIMIT 1`,
    args: [id],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const r = rs.rows[0] as any;
  /* A private board (`prj_wb_…`) is its owner's alone (lib/draftProject.ts): to anyone else it is as absent as an unknown id. */
  if (!r || !(await mayReachProject(got.user, String(r.id), "read"))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  /* The cap the gate enforces: its own, else the workspace's budget per production (lib/caps.ts projectCap). */
  const inCredits = creditsApply(requireTenant());
  const capped = effectiveCapRow({ capCredits: r.cap_credits == null ? null : Number(r.cap_credits) }, inCredits ? await workspaceBudget() : null, inCredits);
  return NextResponse.json({
    project: {
      id: String(r.id), name: String(r.name ?? ""), description: r.description == null ? "" : String(r.description),
      code: String(r.code ?? ""), category: String(r.category ?? ""),
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd), ...capped,
      capUnlocked: Number(r.cap_unlocked ?? 0) === 1,
      productionId: r.production_id ? String(r.production_id) : null,
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
});

export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  /* A private board's project is its owner's alone: to anyone else it is as absent as an unknown id (lib/draftProject.ts). */
  if (!(await mayReachProject(got.user, id))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  /* The cap, in the workspace's unit, and the unlock past it: an admin's alone, and a person's: an API or MCP token
     (even one an admin made) never sets a budget or unlocks one (CLAUDE.md rule 14: spend limits are people-only). */
  if ("capCredits" in body || "capUsd" in body || "capUnlocked" in body) {
    if (got.token) return NextResponse.json({ error: "A production's cap is set by a person, signed in. API tokens cannot change it." }, { status: 403 });
    if (got.user.role !== "admin") return NextResponse.json({ error: "An admin sets a production's cap." }, { status: 403 });
    /* A new cap re-locks the production and re-arms its warning, in the same statement (lib/caps.ts setOwnCap). */
    if ("capCredits" in body) {
      const n = body.capCredits == null || body.capCredits === "" ? null : Math.round(Number(body.capCredits));
      if (n != null && (!Number.isFinite(n) || n < 0)) return NextResponse.json({ error: "A cap is a whole number of credits, or none." }, { status: 400 });
      await setOwnCap(id, "cr", n);
    }
    if ("capUsd" in body) {
      const n = body.capUsd == null || body.capUsd === "" ? null : Number(body.capUsd);
      if (n != null && (!Number.isFinite(n) || n < 0)) return NextResponse.json({ error: "A cap is an amount, or none." }, { status: 400 });
      await setOwnCap(id, "$", n);
    }
    if ("capUnlocked" in body) {
      if (body.capUnlocked) {
        /* An Unlock names the cap the admin was shown: it lands only on that cap, and only at it. */
        const forCap = Number(body.forCap);
        if (body.forCap == null || !Number.isFinite(forCap)) return NextResponse.json({ error: "Unlock needs the cap you were shown. Look again." }, { status: 409 });
        const done = await unlockAtCap(id, forCap);
        if (!done.ok) { invalidate(PROJECTS_KEY); return NextResponse.json({ error: done.error }, { status: done.status }); }
      } else {
        await db().execute({ sql: `UPDATE projects SET cap_unlocked = 0 WHERE id = ?`, args: [id] });
      }
    }
    invalidate(PROJECTS_KEY);
    if (body.name === undefined && body.description === undefined && body.code === undefined && body.category === undefined) {
      return NextResponse.json({ ok: true });
    }
  }
  /* A rename (or a code or a category) of someone else's project is its owner's or an admin's only (lib/workAccess.ts); an unknown id is answered as it always was. */
  if ((await db().execute({ sql: `SELECT 1 FROM projects WHERE id = ?`, args: [id] })).rows.length && !(await mayChangeProject(got.user, id)))
    return NextResponse.json({ error: NOT_YOURS.project }, { status: 403 });
  const code = typeof body.code === "string"
    ? body.code.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16)
    : null;
  const category = typeof body.category === "string" ? body.category.trim().slice(0, 40) : null;
  await db().execute({
    sql: `UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description),
                              code = COALESCE(?, code), category = COALESCE(?, category) WHERE id = ?`,
    args: [body.name ?? null, body.description ?? null, code, category, id],
  });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
});

/**
 * Deleting a project keeps its renders: they fall back to Unfiled, and their
 * cost stays on the ledger. What was filed UNDER the project — its shots,
 * cast, notes and the like — leaves every screen with it, explicitly rather
 * than by the database's cascade rules. Nothing is erased: each row is copied
 * to the archive first, and so is the list of renders that were unfiled.
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  /* A private board's project is its owner's alone: to anyone else it is as absent as an unknown id (lib/draftProject.ts). This comes first. */
  if (!(await mayReachProject(got.user, id))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  /* Deleting a project is its owner's or an admin's (lib/workAccess.ts); an unknown id is answered as it always was ("No such project."). */
  if ((await db().execute({ sql: `SELECT 1 FROM projects WHERE id = ?`, args: [id] })).rows.length && !(await mayChangeProject(got.user, id)))
    return NextResponse.json({ error: NOT_YOURS.project }, { status: 403 });
  /* One write transaction: every step lands or none does, so a failure
     partway never leaves a production still standing with its renders
     already unfiled and its cast already archived. */
  const deleted = await archiveTransaction(async (tx) => {
    const [found, elements, library, stepsTable] = await tx.batch([
      { sql: `SELECT id FROM projects WHERE id = ?`, args: [id] },
      /* Versions and attributes go through their element, which is why the
         element ids are read first. */
      { sql: `SELECT id FROM elements WHERE project_id = ?`, args: [id] },
      /* The Library's filings table exists once a project library was used. */
      { sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_library_uploads'`, args: [] },
      /* A v30 production's steps (the v30 steps store's table) exist only where the switch was used: checked first, as the
         archive refuses a table that is not there (lib/archive.ts) and a customer workspace has never made this one. */
      { sql: `SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_steps'`, args: [] },
    ]);
    if (!found.rows.length) return false;
    /* A draft's own project is one person's board: only its owner deletes it. Its takes and identities are then re-filed into a hidden project of the
       owner's own (never unfiled: the database would drop them into the shared pool, and the uploads they name would open to the team). */
    const privateBoard = isDraftProject(id);
    const holding = privateBoard ? heldBoardsProjectId(requireTenant().id, got.user.id) : null;
    if (privateBoard) {
      if (!(await ownsDraftProject(got.user.id, id, tx))) return false;
      const at = Date.now();
      await tx.execute({ sql: `INSERT OR IGNORE INTO productions (id,name,created_at) VALUES (?,?,?)`, args: [heldBoardsProductionId(requireTenant().id, got.user.id), "Deleted boards", at] });
      await tx.execute({ sql: `INSERT OR IGNORE INTO projects (id,name,description,created_at,production_id) VALUES (?,?,?,?,?)`, args: [holding!, "Deleted boards", "", at, heldBoardsProductionId(requireTenant().id, got.user.id)] });
    }
    const elementIds = elements.rows.map((r) => String((r as unknown as { id: string }).id));
    const holes = elementIds.map(() => "?").join(",");
    /* Rig's rows go with it. Foreign keys are declared but not enforced here,
       so a binding left behind would keep being counted by the impact query —
       a production nobody can open, still adding shots to what a change costs. */
    const steps: ArchiveStep[] = [
      { table: "cast_members", where: `project_id = ?`, args: [id] },
      ...(elementIds.length ? [
        { table: "attribute_versions", where: `element_id IN (${holes})`, args: elementIds },
        { table: "element_attributes", where: `element_id IN (${holes})`, args: elementIds },
        { table: "bindings", where: `element_id IN (${holes})`, args: elementIds },
      ] : []),
      { table: "bindings", where: `project_id = ?`, args: [id] },
      { table: "elements", where: `project_id = ?`, args: [id] },
      { table: "shots", where: `project_id = ?`, args: [id] },
      { table: "canvas_items", where: `project_id = ?`, args: [id] },
      { table: "shot_presets", where: `project_id = ?`, args: [id] },
      /* Originals filed in its library go back to the workspace's uploads, as its renders fall back
         to Unfiled: a filing left pointing at a project that is gone would keep the original from
         ever being deleted ("Remove its project filing first" needs the project). */
      ...(library.rows.length ? [{ table: "project_library_uploads", where: `project_id = ?`, args: [id] }] : []),
      /* Its steps go with it (production_id is the project's own id), held under this workspace only. */
      ...(stepsTable.rows.length ? [{ table: "production_steps", where: `workspace_id = ? AND production_id = ?`, args: [requireTenant().id, id] }] : []),
      { table: "projects", where: `id = ?`, args: [id] },
    ];
    // Every write in one batch: a few round trips hold the write lock, not dozens.
    await tx.batch([
      {
        sql: `INSERT INTO archived_rows(id,table_name,row_id,body,reason,archived_by,archived_at)
              SELECT lower(hex(randomblob(16))), 'generations.project_id', ?, json_group_array(id), 'unfiled', ?, ?
              FROM generations WHERE project_id = ? HAVING COUNT(*) > 0`,
        args: [id, got.user.id, Date.now(), id],
      },
      /* Renders fall back to Unfiled; a private board's go to its owner's hidden project instead. */
      { sql: `UPDATE generations SET project_id = ? WHERE project_id = ?`, args: [holding, id] },
      { sql: `UPDATE identities SET project_id = ? WHERE project_id = ?`, args: [holding, id] },
      ...(await archiveDeleteStatements(tx, steps)),
    ]);
    return true;
  });
  if (!deleted) return NextResponse.json({ error: "No such project." }, { status: 404 });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
});
