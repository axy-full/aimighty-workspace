import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { archiveDeleteStatements, archiveTransaction, type ArchiveStep } from "@/lib/archive";

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
  if (!r) return NextResponse.json({ error: "No such project." }, { status: 404 });
  return NextResponse.json({
    project: {
      id: String(r.id), name: String(r.name ?? ""), description: r.description == null ? "" : String(r.description),
      code: String(r.code ?? ""), category: String(r.category ?? ""),
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd), capCredits: r.cap_credits == null ? null : Number(r.cap_credits),
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
  const body = await req.json().catch(() => ({}));
  /* The cap, in the workspace's unit, and the unlock past it: an admin's alone. */
  if ("capCredits" in body || "capUsd" in body || "capUnlocked" in body) {
    if (got.user.role !== "admin") return NextResponse.json({ error: "An admin sets a production's cap." }, { status: 403 });
    if ("capCredits" in body) {
      const n = body.capCredits == null || body.capCredits === "" ? null : Math.round(Number(body.capCredits));
      if (n != null && (!Number.isFinite(n) || n < 0)) return NextResponse.json({ error: "A cap is a whole number of credits, or none." }, { status: 400 });
      await db().execute({ sql: `UPDATE projects SET cap_credits = ?, cap_warned_at = NULL WHERE id = ?`, args: [n, id] });
    }
    if ("capUsd" in body) {
      const n = body.capUsd == null || body.capUsd === "" ? null : Number(body.capUsd);
      if (n != null && (!Number.isFinite(n) || n < 0)) return NextResponse.json({ error: "A cap is an amount, or none." }, { status: 400 });
      await db().execute({ sql: `UPDATE projects SET cap_usd = ?, cap_warned_at = NULL WHERE id = ?`, args: [n, id] });
    }
    if ("capUnlocked" in body) {
      await db().execute({ sql: `UPDATE projects SET cap_unlocked = ? WHERE id = ?`, args: [body.capUnlocked ? 1 : 0, id] });
    }
    invalidate(PROJECTS_KEY);
    if (body.name === undefined && body.description === undefined && body.code === undefined && body.category === undefined) {
      return NextResponse.json({ ok: true });
    }
  }
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
  /* One write transaction: every step lands or none does, so a failure
     partway never leaves a production still standing with its renders
     already unfiled and its cast already archived. */
  const deleted = await archiveTransaction(async (tx) => {
    const [found, elements] = await tx.batch([
      { sql: `SELECT id FROM projects WHERE id = ?`, args: [id] },
      /* Versions and attributes go through their element, which is why the
         element ids are read first. */
      { sql: `SELECT id FROM elements WHERE project_id = ?`, args: [id] },
    ]);
    if (!found.rows.length) return false;
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
      { sql: `UPDATE generations SET project_id = NULL WHERE project_id = ?`, args: [id] },
      { sql: `UPDATE identities SET project_id = NULL WHERE project_id = ?`, args: [id] },
      ...(await archiveDeleteStatements(tx, steps)),
    ]);
    return true;
  });
  if (!deleted) return NextResponse.json({ error: "No such project." }, { status: 404 });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
});
