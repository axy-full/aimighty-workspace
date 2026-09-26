import {reserveRecoveryContinuation} from "@/lib/recovery";
import { workbenchReady, workbenchTransaction } from "@/lib/workbench/records";
import { mediaBindingProblem } from "@/lib/mediaBindings";
import { NextResponse, after } from "next/server";
import { getGeneration, syncGeneration } from "@/lib/jobs";
import { db, ready } from "@/lib/db";
import { mediaDeletionReady, markGenerationDeletion } from "@/lib/mediaDeletion";
import { requireUser, withTenant } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { getShot, nextVersion } from "@/lib/shots";
import { notify } from "@/lib/push";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { discardHeldJob } from "@/lib/held";
import type { Transaction } from "@libsql/client";

const ACTIVE = "This generation is still active. Wait for it to finish before deleting it.";

/**
 * A held take was never reserved or sent, and it will not finish on its own.
 * Its author or an admin may take it out of the line: it becomes a cancelled
 * take and nothing is charged. Returns the refusal, or null once discarded.
 */
async function discardHeld(tx: Transaction, id: string, row: Record<string, unknown>, user: { id: string; role: string }): Promise<string | null> {
  if (user.role !== "admin" && String(row.created_by ?? "") !== user.id)
    return "Only the person who made this take, or an admin, can discard it.";
  return (await discardHeldJob(id, tx)) ? null : ACTIVE;
}

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
  // Renames, approvals and moves between shots or projects are project
  // writes; a tab whose account or workspace changed must not make them.
  const scopeProblem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (scopeProblem) return NextResponse.json({ error: scopeProblem }, { status: 409 });
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  /* Discard a held take without hiding it: it stays in the list as cancelled. */
  if (body.discard === true) {
    const problem = await workbenchTransaction(async (tx) => {
      const row = (await tx.execute({ sql: "SELECT status, created_by FROM generations WHERE id=? AND deleted=0", args: [id] })).rows[0];
      if (!row) return "No such render.";
      if (String(row.status) !== "held") return "Only a held take can be discarded.";
      return discardHeld(tx, id, row, got.user);
    });
    if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  }
  /* Trash and restore (FINAL_SPEC §1 step 1: delete is soft). A trashed
     render is hidden — `deleted=1` — and keeps its bytes for good: nothing a
     team makes is ever erased (owner, 2026-09-24), so `{ trashed: false }`
     always brings it back whole. Only a render whose bytes were removed by
     an older release cannot be restored, and says so. */
  if (body.trashed !== undefined) {
    await workbenchReady();
    await mediaDeletionReady();
    const problem = await workbenchTransaction(async (tx) => {
      const row = (await tx.execute({ sql: "SELECT status, deleted, stored_url, bytes, created_by FROM generations WHERE id=?", args: [id] })).rows[0];
      if (!row) return "No such render.";
      if (body.trashed === true) {
        if (["queued", "running"].includes(String(row.status))) return ACTIVE;
        const binding = await mediaBindingProblem(tx, "generation", id);
        if (binding) return binding;
        if (String(row.status) === "held") {
          const refused = await discardHeld(tx, id, row, got.user);
          if (refused) return refused;
        }
        await markGenerationDeletion(tx, id, Date.now());
        return null;
      }
      if (!Number(row.deleted)) return null;
      const pending = (await tx.execute({ sql: "SELECT lease FROM generation_deletions WHERE id=?", args: [id] })).rows[0];
      if ((pending && pending.lease != null) || (row.stored_url == null && !Number(row.bytes))) return "This render's original has already been removed; it cannot be restored.";
      await tx.execute({ sql: "DELETE FROM generation_deletions WHERE id=?", args: [id] });
      await tx.execute({ sql: "UPDATE generations SET deleted=0, updated_at=? WHERE id=?", args: [Date.now(), id] });
      return null;
    });
    if (problem) return NextResponse.json({ error: problem }, { status: 409 });
    invalidate(PROJECTS_KEY);
  }
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
 * "Delete" hides the clip; the row, its cost and its file all stay. Money
 * already spent must never vanish from the ledger, and nothing a team makes
 * is ever erased (owner, 2026-09-24) — a deleted render can be restored.
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
    const row = (await tx.execute({ sql: "SELECT status, created_by FROM generations WHERE id=?", args: [id] })).rows[0];
    if (row && ["queued", "running"].includes(String(row.status))) return ACTIVE;
    const binding = await mediaBindingProblem(tx, "generation", id);
    if (binding) return binding;
    if (row && String(row.status) === "held") {
      const refused = await discardHeld(tx, id, row, got.user);
      if (refused) return refused;
    }
    // Keep the cost row for accounting. Source validation in draft saves shares this lock.
    await markGenerationDeletion(tx, id);
    return null;
  });
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });
  invalidate(PROJECTS_KEY);
  return NextResponse.json({ ok: true, cleanupPending: false });
});
