import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getLook, cleanSpec, LOOK_CATEGORIES, MAX_LOOK_REFS } from "@/lib/looks";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Edit a Look. Shipped Looks are read-only — duplicate one to change it. */
export async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const look = await getLook(id);
  if (!look) return NextResponse.json({ error: "No such look." }, { status: 404 });
  if (look.builtin) {
    return NextResponse.json({ error: "That look ships with Particl. Duplicate it to make your own." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { sets.push(`${col}=?`); args.push(v); };

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 60) return NextResponse.json({ error: "Give the look a name under 60 characters." }, { status: 400 });
    set("name", name);
  }
  if (body.spec !== undefined) set("spec", JSON.stringify(cleanSpec(body.spec)));
  if (typeof body.prose === "string") set("prose", body.prose.trim().slice(0, 1200));
  if (typeof body.blurb === "string") set("blurb", body.blurb.trim().slice(0, 140));
  if (typeof body.category === "string") {
    set("category", (LOOK_CATEGORIES as readonly string[]).includes(body.category) ? body.category : "Custom");
  }
  if (Array.isArray(body.refs)) {
    set("refs", JSON.stringify(body.refs.filter((x: unknown) => typeof x === "string").slice(0, MAX_LOOK_REFS)));
  }
  if (body.coverGenId !== undefined) set("cover_gen_id", body.coverGenId ? String(body.coverGenId) : null);
  if (body.coverUploadId !== undefined) set("cover_upload_id", body.coverUploadId ? String(body.coverUploadId) : null);
  if (!sets.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  set("updated_at", now());
  await db().execute({ sql: `UPDATE shot_presets SET ${sets.join(", ")} WHERE id=?`, args: [...args, id] });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const look = await getLook(id);
  if (!look) return NextResponse.json({ ok: true });
  if (look.builtin) {
    return NextResponse.json({ error: "That look ships with Particl and can't be deleted." }, { status: 400 });
  }
  await db().execute({ sql: `DELETE FROM shot_presets WHERE id = ?`, args: [id] });
  return NextResponse.json({ ok: true });
}
