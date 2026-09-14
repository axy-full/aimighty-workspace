import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { workbenchReady, workbenchTransaction } from "@/lib/workbench/records";
import { mediaBindingProblem } from "@/lib/mediaBindings";
import { uploadReservationsReady, queueUploadDeletion, cleanupExpiredUploads, UploadError, uploadFailure } from "@/lib/uploadReservations";
import { db, ready } from "@/lib/db";
import { servingFor } from "@/lib/serveType";
import { requireUser, withTenant } from "@/lib/auth";
import { readUploadBytes, openUploadStream } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 800;
type Ctx = { params: Promise<{ id: string }> };

/**
 * Serves the original bytes with the original content type. No transform.
 * Large files STREAM through — a 2GB chat attachment must never be buffered
 * into function memory. Unknown types download as attachments with sniffing
 * off, so an uploaded HTML file can't run in the app's origin.
 */
export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;

  const rs = await db().execute({
    sql: `SELECT mime, ext, bytes, kind, filename, stored_url FROM uploads WHERE id = ? LIMIT 1`,
    args: [id],
  });
  const row = rs.rows[0] as unknown as {
    mime: string; ext: string; bytes: number; kind: string; filename: string; stored_url: string;
  } | undefined;
  if (!row) return new Response("Not found", { status: 404 });

  /* The stored `mime` is not evidence, so it decides nothing on its own.
     On the chat path the client named it and only its SHAPE was checked,
     while `kind` was sniffed from three bytes — so `kind: "image"` with
     `mime: "text/html"` was storable, and this route used to echo that back
     inline on the app's own origin. `nosniff` does not save it: it makes a
     browser HONOUR the declared type, which is the whole problem.
     `servingFor` answers one question — may a browser render this type —
     from an allowlist, and everything else leaves as a download. Applied
     here rather than only at upload because rows written before this are
     already in the database. */
  const serve = servingFor(row.mime);
  const headers: Record<string, string> = {
    "Content-Type": serve.contentType,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!serve.inline) {
    headers["Content-Disposition"] =
      `attachment; filename="${row.filename.replace(/[^\w. -]/g, "_")}"`;
  }

  try {
    if (Number(row.bytes) > 8 * 1024 * 1024 || row.kind === "file") {
      const { stream, size } = await openUploadStream(id, row.ext);
      if (size != null) headers["Content-Length"] = String(size);
      return new Response(stream, { headers });
    }
    const buf = await readUploadBytes(id, row.ext, row.stored_url);
    headers["Content-Length"] = String(buf.length);
    return new Response(new Uint8Array(buf), { headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
});

export const DELETE = withTenant(async function DELETE(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const scopeProblem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (scopeProblem) return Response.json({ error: scopeProblem }, { status: 409 });
  await ready();
  const { id } = await params;
  try {
    await workbenchReady();
    await uploadReservationsReady();
    const key = await workbenchTransaction(async tx => {
      const problem = await mediaBindingProblem(tx, "upload", id);
      if (problem) throw new UploadError(problem, 409);
      return queueUploadDeletion(tx, got.user.id, id);
    });
    // If storage is unavailable, the durable cleanup row retains quota and retries in cron.
    const result = key ? await cleanupExpiredUploads(1, Date.now(), key) : null;
    return Response.json({ ok: true, cleanupPending: Boolean(result && result.cleaned !== 1) });
  } catch (error) { return uploadFailure(error); }
});
