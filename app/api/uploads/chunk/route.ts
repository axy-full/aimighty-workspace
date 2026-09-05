import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { storeChunk } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SESSION = /^[a-f0-9-]{16,64}$/;

/** One slice of a large upload. Chunks stay under Vercel's 4.5MB body cap. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;

  const form = await req.formData().catch(() => null);
  const file = form?.get("chunk");
  const session = String(form?.get("session") ?? "");
  const index = Number(form?.get("index"));

  if (!(file instanceof File) || !SESSION.test(session) || !Number.isInteger(index) || index < 0 || index > 600) {
    return NextResponse.json({ error: "Bad chunk" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0 || buf.length > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "Chunk size out of range" }, { status: 400 });
  }
  // Scope the staging area to the uploader, so sessions can't collide or be
  // hijacked across users.
  await storeChunk(`${got.user.id}/${session}`, index, buf);
  return NextResponse.json({ ok: true, index });
});
