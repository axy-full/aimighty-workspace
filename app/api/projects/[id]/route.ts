import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

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
 * cast, notes and the like — goes with it, deleted here explicitly rather
 * than left to the database's cascade rules.
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const found = await db().execute({ sql: `SELECT id FROM projects WHERE id = ?`, args: [id] });
  if (!found.rows.length) return NextResponse.json({ error: "No such project." }, { status: 404 });
  await db().execute({ sql: `UPDATE generations SET project_id = NULL WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `UPDATE identities SET project_id = NULL WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM cast_members WHERE project_id = ?`, args: [id] });
  /* Rig's rows go with it. Foreign keys are declared but not enforced here,
     so a binding left behind would keep being counted by the impact query —
     a production nobody can open, still adding shots to what a change costs.
     Versions and attributes go through their element, which is why the
     element ids are read first. */
  const elements = await db().execute({ sql: `SELECT id FROM elements WHERE project_id = ?`, args: [id] });
  const elementIds = elements.rows.map((r) => String((r as unknown as { id: string }).id));
  if (elementIds.length) {
    const holes = elementIds.map(() => "?").join(",");
    await db().execute({ sql: `DELETE FROM attribute_versions WHERE element_id IN (${holes})`, args: elementIds });
    await db().execute({ sql: `DELETE FROM element_attributes WHERE element_id IN (${holes})`, args: elementIds });
    await db().execute({ sql: `DELETE FROM bindings WHERE element_id IN (${holes})`, args: elementIds });
  }
  await db().execute({ sql: `DELETE FROM bindings WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM elements WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM shots WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM canvas_items WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM shot_presets WHERE project_id = ?`, args: [id] });
  await db().execute({ sql: `DELETE FROM projects WHERE id = ?`, args: [id] });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
});
