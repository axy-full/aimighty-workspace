import {reserveRecoveryContinuation} from "@/lib/recovery";
import { workbenchReady, workbenchTransaction } from "@/lib/workbench/records";
import { mediaBindingProblem } from "@/lib/mediaBindings";
import { NextResponse, after } from "next/server";
import { getGeneration, syncGeneration } from "@/lib/jobs";
import { db, ready } from "@/lib/db";
import { mediaDeletionReady, markGenerationDeletion, cleanupDeletedGenerations } from "@/lib/mediaDeletion";
import { requireUser, withTenant } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { getShot, nextVersion } from "@/lib/shots";
import { notify } from "@/lib/push";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, false);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Drag resolution only needs persisted metadata. It must not poll a provider,
  // copy a master or advance accounting merely because someone selected a take.
  const generation = new URL(req.url).searchParams.get("sync") === "0"
    ? gen : await syncGeneration(gen);
  return NextResponse.json({ generation }, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.projectId !== undefined) {
    await db().execute({
      sql: `UPDATE generations SET project_id=?, updated_at=? WHERE id=?`,
      args: [body.projectId || null, Date.now(), id],
    });
  }
  // A name for the render. Empty clears it — the clip id comes back.
  if (body.title !== undefined) {
    const title = String(body.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    await db().execute({
      sql: `UPDATE generations SET title=?, updated_at=? WHERE id=?`,
      args: [title || null, Date.now(), id],
    });
  }
  // Signing off on a shot, or asking for changes. The name is recorded so a
  // review is answerable to someone rather than appearing from nowhere.
  if (body.reviewState !== undefined) {
    /* draft → picked → approved. An artist picks one take per shot; a
       director approves it or sends it back. */
    const state = ["approved", "picked", "changes", ""].includes(String(body.reviewState))
      ? String(body.reviewState) : "";
    /* The trail keeps both marks: who picked and who approved, each with its
       own moment (brief 2.1). Clearing a state clears that mark alone, so a
       take sent back for changes still says who had picked it. */
    const ts = Date.now();
    await db().execute({
      sql: `UPDATE generations SET review_state=?, review_by=?, reviewed_at=?,
                   picked_by = CASE WHEN ? THEN ? ELSE picked_by END,
                   picked_at = CASE WHEN ? THEN ? ELSE picked_at END,
                   approved_by = CASE WHEN ? THEN ? ELSE approved_by END,
                   approved_at = CASE WHEN ? THEN ? ELSE approved_at END,
                   updated_at=? WHERE id=?`,
      args: [state, state ? got.user.name : null, state ? ts : null,
             state === "picked" ? 1 : 0, got.user.name, state === "picked" ? 1 : 0, ts,
             state === "approved" ? 1 : 0, got.user.name, state === "approved" ? 1 : 0, ts,
             ts, id],
    });
    /* Picking a take asks someone for a decision: tell the admins who want
       to be asked (brief 2.7). Approving it, or sending it back, is the
       decision itself and needs no nudge. */
    if (state === "picked") {
      after(await reserveRecoveryContinuation('after-response', async () => {
        const admins = await db().execute({ sql: `SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND deleted_at IS NULL AND id <> ?`, args: [got.user.id] });
        const gen = await getGeneration(id).catch(() => null);
        const where = gen?.shotCode ? `${gen.shotCode} v${gen.version ?? 1}` : "A take";
        await notify("approvalNeeded", (admins.rows as unknown as { id: string }[]).map((r) => String(r.id)),
          { title: `${where} is waiting on you`, body: `${got.user.name} picked it.`, url: "/" }).catch(() => {});
      }));
    }
  }
  /* Filing against a shot, moving between shots, or unfiling. A video or a
     still takes the shot's next version number on the way in; an audio
     track carries none. The render follows the shot into its production. */
  if (body.shotId !== undefined) {
    const shotId = body.shotId ? String(body.shotId) : null;
    if (shotId) {
      const shot = await getShot(shotId);
      if (!shot) return NextResponse.json({ error: "That shot is gone." }, { status: 404 });
      const gen = await getGeneration(id);
      if (!gen) return NextResponse.json({ error: "No such render." }, { status: 404 });
      const version = gen.kind === "audio" ? null : await nextVersion(shotId);
      await db().execute({
        sql: `UPDATE generations SET shot_id=?, version=?, project_id=COALESCE(?, project_id), updated_at=? WHERE id=?`,
        args: [shotId, version, shot.projectId, Date.now(), id],
      });
    } else {
      await db().execute({
        sql: `UPDATE generations SET shot_id=NULL, version=NULL, updated_at=? WHERE id=?`,
        args: [Date.now(), id],
      });
    }
  }
  /* A still's role on the production — first frame, cast still, loose.
     Kept in params so a role is a fact about the render, not a second
     table; a cast still may carry the @name it stands for. */
  if (body.useAs !== undefined) {
    const useAs = ["first", "cast", "loose"].includes(String(body.useAs)) ? String(body.useAs) : "loose";
    const castName = body.castName ? String(body.castName).replace(/^@/, "").trim().slice(0, 40) : null;
    await db().execute({
      sql: `UPDATE generations SET params = json_set(params, '$.useAs', ?, '$.castName', ?), updated_at=? WHERE id=?`,
      args: [useAs, castName, Date.now(), id],
    });
  }
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true });
});

/**
 * "Delete" removes the video file and hides the clip, but the row survives
 * with its cost — money already spent must never vanish from the ledger.
 * Hard-deleting rows made "remaining credit" drift optimistic with every
 * library cleanup.
 */
export const DELETE = withTenant(async function DELETE(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  // A browser tab whose account or workspace changed underneath it must not
  // tombstone a clip in the workspace that is now active. Same rule as the
  // upload DELETE; API tokens carry their own scope.
  const scopeProblem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (scopeProblem) return NextResponse.json({ error: scopeProblem }, { status: 409 });
  await ready();
  const { id } = await params;
  await workbenchReady();
  await mediaDeletionReady();
  const problem = await workbenchTransaction(async tx => {
    const row = (await tx.execute({ sql: "SELECT status FROM generations WHERE id=?", args: [id] })).rows[0];
    if (row && ["queued", "running", "held"].includes(String(row.status))) return "This generation is still active. Wait for it to finish before deleting it.";
    const binding = await mediaBindingProblem(tx, "generation", id);
    if (binding) return binding;
    // Keep the cost row for accounting. Source validation in draft saves shares this lock.
    await markGenerationDeletion(tx, id);
    return null;
  });
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  const cleanup = await cleanupDeletedGenerations(1, Date.now(), id);
  invalidate(PROJECTS_KEY);
  const pending = (await db().execute({ sql: "SELECT 1 FROM generation_deletions WHERE id=?", args: [id] })).rows.length > 0;
  return NextResponse.json({ ok: true, cleanupPending: pending }, { status: pending || cleanup.failed ? 202 : 200 });
});
