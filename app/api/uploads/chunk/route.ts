import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { storeChunk } from "@/lib/storage";
import { abortUploadSession, markUploadChunkStored, reserveUploadChunk, UploadError, uploadFailure } from "@/lib/uploadReservations";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Admission is durable and atomic before any chunk bytes reach storage. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get("chunk");
    if (!(file instanceof File) || file.size < 1 || file.size > 4 * 1024 * 1024) throw new UploadError("Chunk size out of range.");
    const index = Number(form?.get("index"));
    const buf = Buffer.from(await file.arrayBuffer());
    const claim = await reserveUploadChunk({ owner: got.user.id, session: String(form?.get("session") ?? ""), index, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
    if (!claim.stored) {
      await storeChunk(claim.key, index, buf);
      await markUploadChunkStored(claim.key, index, claim.lease);
    }
    return NextResponse.json({ ok: true, index });
  } catch (error) { return uploadFailure(error); }
});

/** Cancelling does not race an in-flight write; cleanup waits for its durable lease. */
export const DELETE = withTenant(async function DELETE(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  try {
    const body = await req.json().catch(() => ({}));
    await abortUploadSession(got.user.id, String(body.session ?? ""));
    return NextResponse.json({ ok: true });
  } catch (error) { return uploadFailure(error); }
});
