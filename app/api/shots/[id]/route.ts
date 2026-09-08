import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { getShot, STATUSES, codeProblem } from "@/lib/shots";

export const dynamic = "force-dynamic";

export const PATCH = withTenant(async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id: shotId } = await ctx.params;
  await ready();
  const shot = await getShot(shotId);
  if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const sets: string[] = [];
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const args: any[] = [];

  if (typeof body.code === "string") {
    const problem = codeProblem(body.code.trim());
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    sets.push("code = ?"); args.push(body.code.trim());
  }
  for (const [field, col, max] of [
    ["scene", "scene", 40], ["title", "title", 160], ["description", "description", 2000],
  ] as const) {
    if (typeof body[field] === "string") { sets.push(`${col} = ?`); args.push(body[field].slice(0, max)); }
  }
  if (typeof body.status === "string" && STATUSES.includes(body.status)) {
    sets.push("status = ?"); args.push(body.status);
  }
  if (typeof body.position === "number" && Number.isFinite(body.position)) {
    sets.push("position = ?"); args.push(Math.round(body.position));
  }
  if (body.planned !== undefined) {
    const n = body.planned == null || body.planned === "" ? null : Math.max(1, Math.min(60, Math.round(Number(body.planned))));
    sets.push("planned = ?"); args.push(Number.isFinite(n as number) || n == null ? n : null);
  }
  if (body.setup && typeof body.setup === "object") { sets.push("setup = ?"); args.push(JSON.stringify(body.setup)); }
  if (Array.isArray(body.cast)) { sets.push("cast = ?"); args.push(JSON.stringify(body.cast.map(String).slice(0, 20))); }
  if (body.kind === "type" || body.kind === "render") { sets.push("kind = ?"); args.push(body.kind); }
  if (!sets.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  /* Any edit is a change the shot list has not sent across yet. */
  sets.push("dirty = 1");
  sets.push("updated_at = ?"); args.push(now(), shotId);
  await db().execute({ sql: `UPDATE shots SET ${sets.join(", ")} WHERE id = ?`, args });
  return NextResponse.json({ shot: await getShot(shotId) });
});

export const DELETE = withTenant(async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id: shotId } = await ctx.params;
  await ready();
  // Renders outlive the shot they were filed under — unfile them, never
  // delete work because a slate was tidied away.
  await db().execute({ sql: `UPDATE generations SET shot_id = NULL WHERE shot_id = ?`, args: [shotId] });
  /* What this shot pointed at goes with it. A binding is not work and holds
     nothing anyone would miss, and one left behind keeps voting on what a
     change costs: a shot nobody can open would still be counted, and priced,
     every time a version it named was swapped. */
  await db().execute({ sql: `DELETE FROM bindings WHERE shot_id = ?`, args: [shotId] });
  await db().execute({ sql: `DELETE FROM shots WHERE id = ?`, args: [shotId] });
  return NextResponse.json({ ok: true });
});
