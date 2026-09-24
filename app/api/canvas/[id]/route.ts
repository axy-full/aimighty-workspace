import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { archiveAndDelete } from "@/lib/archive";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Move, resize, retitle or raise one card. Kept deliberately small — this
 *  fires on every drag release, so it must stay a single indexed UPDATE. */
export const PATCH = withTenant(async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id: itemId } = await ctx.params;
  await ready();
  const body = await req.json().catch(() => ({}));

  const sets: string[] = [];
  const args: any[] = [];
  for (const k of ["x", "y", "w", "h", "z"] as const) {
    if (typeof body[k] === "number" && Number.isFinite(body[k])) {
      sets.push(`${k} = ?`); args.push(Math.round(body[k]));
    }
  }
  if (typeof body.text === "string") { sets.push("text = ?"); args.push(body.text.slice(0, 2000)); }
  if (typeof body.colour === "string") { sets.push("colour = ?"); args.push(body.colour.slice(0, 24)); }
  if (!sets.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  sets.push("updated_at = ?"); args.push(now(), itemId);
  await db().execute({ sql: `UPDATE canvas_items SET ${sets.join(", ")} WHERE id = ?`, args });
  return NextResponse.json({ ok: true });
});

/** Taking a card off the board never touches the render it points at. */
export const DELETE = withTenant(async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id: itemId } = await ctx.params;
  await ready();
  await archiveAndDelete(db(), "canvas_items", `id = ?`, [itemId]);
  return NextResponse.json({ ok: true });
});
