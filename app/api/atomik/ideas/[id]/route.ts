import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getIdea } from "@/lib/atomikDocs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Edit a card. `pin` toggles this person's pin; `state` moves it between
 * open, pinned and parked; `projectId` records the production it became.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const idea = await getIdea(id);
  if (!idea) return NextResponse.json({ error: "No such idea." }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const sets: string[] = [];
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const args: any[] = [];
  if (typeof body.logline === "string") { sets.push("logline = ?"); args.push(body.logline.trim().slice(0, 600)); }
  if (Array.isArray(body.tone)) { sets.push("tone = ?"); args.push(JSON.stringify(body.tone.map(String).slice(0, 8))); }
  if (Array.isArray(body.refs)) { sets.push("refs = ?"); args.push(JSON.stringify(body.refs.map(String).slice(0, 3))); }
  if (body.pin !== undefined) {
    const pins = new Set(idea.pins);
    if (pins.has(got.user.id)) pins.delete(got.user.id); else pins.add(got.user.id);
    sets.push("pins = ?"); args.push(JSON.stringify([...pins]));
    // A pinned card is pinned; the last pin coming off leaves it open.
    if (idea.state === "open" || idea.state === "pinned") { sets.push("state = ?"); args.push(pins.size ? "pinned" : "open"); }
  }
  if (["open", "pinned", "production", "parked"].includes(body.state)) {
    sets.push("state = ?"); args.push(body.state);
    sets.push("parked_by = ?"); args.push(body.state === "parked" ? got.user.id : null);
  }
  if (body.projectId !== undefined) { sets.push("project_id = ?"); args.push(body.projectId ? String(body.projectId) : null); }
  if (!sets.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  sets.push("updated_at = ?"); args.push(now(), id);
  await db().execute({ sql: `UPDATE ideas SET ${sets.join(", ")} WHERE id = ?`, args });
  return NextResponse.json({ idea: await getIdea(id) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  await db().execute({ sql: `DELETE FROM ideas WHERE id = ?`, args: [id] });
  return NextResponse.json({ ok: true });
}
