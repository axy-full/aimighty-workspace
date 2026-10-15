import { assertMoveAllowed, MoveRefused, parseJson } from "@/lib/projectMove";
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
import { withLedgerCharges } from "@/lib/usageLedger";
import { NO_SUCH_PROJECT, mayReachProject, mayReadTake } from "@/lib/draftProject";
import { NOT_YOURS, mayChangeProject, mayChangeWork } from "@/lib/workAccess";
import { readableActors } from "@/lib/platformOwnerPrivacy";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";
import type { Transaction } from "@libsql/client";

const ACTIVE = "This generation is still active. Wait for it to finish before deleting it.";
/** The review trail's states; "" takes a take back to review. */
const REVIEW_STATES = ["picked", "approved", "changes", ""];

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

/** The take's id as the rest of the route should read it: a take filed in a private board that this person may not write is read as an id that names no take, so every answer after is an unknown take's. */
async function takeIdFor(user: { id: string }, id: string): Promise<string> {
  const row = (await db().execute({ sql: "SELECT project_id FROM generations WHERE id=?", args: [id] })).rows[0];
  return row && row.project_id != null && !(await mayReachProject(user, String(row.project_id), "write")) ? NO_SUCH_PROJECT : id;
}

/** A take someone else made: its maker, the board's owner or an admin changes it (lib/workAccess.ts). A missing take is an unknown id and is left to the route's own answer for one. Null when the person may. */
async function notYours(user: { id: string; role: "admin" | "member"; owner?: boolean }, id: string): Promise<Response | null> {
  const row = (await db().execute({ sql: "SELECT created_by, project_id, status FROM generations WHERE id=?", args: [id] })).rows[0];
  if (!row) return null;
  /* A held take was never sent: taking it out of the line is its author's or an admin's (discardHeld), and that rule speaks for it. */
  if (String(row.status) === "held") return null;
  if (await mayChangeWork(user, { createdBy: row.created_by == null ? null : String(row.created_by), projectId: row.project_id == null ? null : String(row.project_id) })) return null;
  return NextResponse.json({ error: NOT_YOURS.take }, { status: 403 });
}

/** Where a take is moved to is asked as well as the take: a project or a shot that is someone else's work takes it from its owner or an admin only. An unknown target is answered as it always was. */
async function notThere(user: { id: string; role: "admin" | "member"; owner?: boolean }, body: { projectId?: unknown; shotId?: unknown }): Promise<Response | null> {
  if (body.projectId !== undefined && body.projectId) {
    const target = String(body.projectId);
    /* A private board is its owner's to write and asking comes first: it is answered as a project that is not there, as is a project that is not there. */
    if (!(await db().execute({ sql: "SELECT 1 FROM projects WHERE id=?", args: [target] })).rows.length || !(await mayReachProject(user, target, "write")))
      return NextResponse.json({ error: "No such project." }, { status: 404 });
    if (!(await mayChangeProject(user, target)))
      return NextResponse.json({ error: NOT_YOURS.moveToProject }, { status: 403 });
  }
  if (body.shotId !== undefined && body.shotId) {
    const shot = await getShot(String(body.shotId));
    /* A shot that is not there and one in a private board are refused alike, here, before any other change in the request lands. */
    if (!shot || !(await mayReachProject(user, shot.projectId, "write"))) return NextResponse.json({ error: "That shot is gone." }, { status: 404 });
    if (shot && !(await mayChangeWork(user, shot))) return NextResponse.json({ error: NOT_YOURS.moveToShot }, { status: 403 });
  }
  return null;
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
  /* A take of a private board this person may not see is as absent as an unknown id (lib/draftProject.ts): the same 404, the same words, after the same read. */
  if (!gen || !(await mayReadTake(got.user, gen.projectId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Drag resolution only needs persisted metadata. It must not poll a provider,
  // copy a master or advance accounting merely because someone selected a take.
  const synced = new URL(req.url).searchParams.get("sync") === "0"
    ? gen : await syncGeneration(gen, { requestPath: true }); // a busy store: the next poll saves it
  const [generation] = await withLedgerCharges([synced]);
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
  const asked = (await params).id;
  const body = (await req.json().catch(() => null)) ?? {};
  /* Approving a take is a person's alone (owner, 14 Oct; CLAUDE.md rules 11 and 14): an API token, an MCP client or an agent identity prepares, picks and sends back, and never signs off.
     Asked before the take is read, so a take that is there and one that is not answer alike. (Clearing a sign-off is asked below, once the take's state is known.) */
  const person = isPerson({ user: got.user, token: got.token });
  /* The review is read once, here: a word (null clears it), or the request is refused before any read. The gate below, the validation and the write all read this value and never the
     raw body, so a value that is not a word (an array holding "approved", a number, an object) can neither pass the gate nor be written as something else. */
  const reviewTo: string | undefined = body.reviewState === undefined ? undefined : body.reviewState === null ? "" : typeof body.reviewState === "string" ? body.reviewState : "bad";
  if (reviewTo === "bad") return NextResponse.json({ error: "A review is picked, approved or changes, or empty to clear it." }, { status: 400 });
  if (reviewTo === "approved" && !person) return NextResponse.json({ error: PEOPLE_ONLY }, { status: 403 });
  /* A project and a shot are each named by one id: a string, or null / "" for none. Anything else (an array, a number, an object) is refused here, before any
     read or write, so the id that is checked below is the very id that is written. Every check below reads these, never the raw body. */
  const idOf = (value: unknown): string | null | "bad" => (value === null || value === "" ? null : typeof value === "string" ? value : "bad");
  const projectTo = body.projectId === undefined ? undefined : idOf(body.projectId);
  const shotTo = body.shotId === undefined ? undefined : idOf(body.shotId);
  if (projectTo === "bad" || shotTo === "bad")
    return NextResponse.json({ error: "A project or a shot is named by its id, or left empty for none." }, { status: 400 });
  /* Nothing is written into the marked sample production, by anyone: not a take's move into it or out of it, nor its filing against one of its shots (lib/demo/readonly.server.ts).
     Read from the id as it was asked, before the private-board rule below reads such a take as no take: the sample answers "view only" to everyone. */
  {
    const inTake = (await db().execute({ sql: "SELECT project_id FROM generations WHERE id=?", args: [asked] })).rows[0];
    const shotProject = shotTo ? (await getShot(shotTo))?.projectId ?? null : null;
    /* Loaded here: only this edit asks, the delete below never does. */
    const { sampleWriteRefusal } = await import("@/lib/demo/readonly.server");
    for (const project of [inTake?.project_id == null ? null : String(inTake.project_id), projectTo ?? null, shotProject]) { const refused = await sampleWriteRefusal(project); if (refused) return refused; }
  }
  /* A take of a private board this person may not write is read as no take (#685), so every answer after is an unknown take's. */
  const id = await takeIdFor(got.user, asked);
  /* A move to another project (or to none) changes who may open the uploads the take names: asked like an addition, before anything is written
     (lib/projectMove.ts). A take in a draft's own project leaves it only with its owner. Refused as an unknown take is. */
  if (projectTo !== undefined) {
    const cur = (await db().execute({ sql: "SELECT project_id, params FROM generations WHERE id=?", args: [id] })).rows[0];
    if (cur) {
      try { await assertMoveAllowed(db(), { from: cur.project_id == null ? null : String(cur.project_id), to: projectTo, named: [parseJson(cur.params)] }); }
      catch (error) { if (error instanceof MoveRefused) return NextResponse.json({ error: "Not found" }, { status: 404 }); throw error; }
    }
  }
  /* Filing a take against a shot moves it into the shot's project (the COALESCE in the update below): asked like any move, before anything is written,
     and refused as a missing shot is. */
  if (shotTo) {
    const shot = await getShot(shotTo);
    const cur = shot ? (await db().execute({ sql: "SELECT project_id, params FROM generations WHERE id=?", args: [id] })).rows[0] : null;
    if (shot && cur) {
      const from = cur.project_id == null ? null : String(cur.project_id);
      try { await assertMoveAllowed(db(), { from, to: shot.projectId ?? from, named: [parseJson(cur.params)] }); }
      catch (error) { if (error instanceof MoveRefused) return NextResponse.json({ error: "That shot is gone." }, { status: 404 }); throw error; }
    }
  }
  /* A review is checked before anything is written: a state the trail knows
     (an unknown word used to clear a sign-off), a take still in the project,
     and a mark only on a take that finished — a render in flight, held or
     failed has nothing to judge yet. Clearing is always allowed. */
  let reviewedFrom: string | null = null;
  if (reviewTo !== undefined) {
    const wanted = reviewTo;
    if (!REVIEW_STATES.includes(wanted)) return NextResponse.json({ error: "A review is picked, approved or changes, or empty to clear it." }, { status: 400 });
    const row = (await db().execute({ sql: "SELECT status, review_state FROM generations WHERE id=? AND deleted=0", args: [id] })).rows[0];
    if (!row) return NextResponse.json({ error: "This take is no longer in the project." }, { status: 404 });
    if (wanted && String(row.status) !== "succeeded") return NextResponse.json({ error: "Only a finished take can be picked, approved or sent back." }, { status: 409 });
    reviewedFrom = String(row.review_state ?? "");
    /* A sign-off is undone by a person alone: a token or an agent cannot clear, pick over or send back what a person approved (that would pull it off a client's review link too). */
    if (reviewedFrom === "approved" && wanted !== "approved" && !person) return NextResponse.json({ error: PEOPLE_ONLY }, { status: 403 });
  }
  /* Someone else's take is changed by its maker, the board's owner or an admin only: a rename, a move, a review, a trash or a restore alike.
     (After the checks above, which only read: a word the trail does not know, a take that is gone or not finished answer as they did.) */
  const refused = await notYours(got.user, id);
  if (refused) return refused;
  const refusedTarget = await notThere(got.user, { projectId: projectTo, shotId: shotTo });
  if (refusedTarget) return refusedTarget;
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
  /* Trash and restore (delete is soft). A trashed
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
  if (projectTo !== undefined) {
    await db().execute({
      sql: `UPDATE generations SET project_id=?, updated_at=? WHERE id=?`,
      args: [projectTo, Date.now(), id],
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
  let review: Record<string, unknown> | null = null;
  if (reviewTo !== undefined) {
    /* draft → picked → approved. An artist picks one take per shot; a
       director approves it or sends it back. (Checked above.) */
    const state = reviewTo;
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
    /* The marks as recorded, for the grids to show at once (who picked, who approved, when). */
    const marks = (await db().execute({ sql: "SELECT review_state, review_by, picked_by, picked_at, approved_by, approved_at, updated_at FROM generations WHERE id=?", args: [id] })).rows[0];
    /* A mark this change left alone may hold an account id (an older row): who marked it is read as a reader may be told, never as an id (lib/platformOwnerPrivacy.ts). */
    const shown = marks ? await readableActors([marks.review_by, marks.picked_by, marks.approved_by]) : null;
    if (marks && shown) review = {
      reviewState: String(marks.review_state ?? ""), reviewBy: shown(marks.review_by),
      pickedBy: shown(marks.picked_by), pickedAt: marks.picked_at == null ? null : Number(marks.picked_at),
      approvedBy: shown(marks.approved_by), approvedAt: marks.approved_at == null ? null : Number(marks.approved_at),
      updatedAt: Number(marks.updated_at),
    };
    /* Picking a take asks someone for a decision: tell the admins who want
       to be asked (brief 2.7), in this workspace, through the app's own
       notifications. Approving it, or sending it back, is the decision
       itself and needs no nudge; nor does a take that was already picked. */
    if (state === "picked" && reviewedFrom !== "picked") {
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
     track takes none and keeps the number it has. The render follows the
     shot into its production. `version` is NOT NULL (lib/db.ts): unfiling
     puts back the default an unfiled render carries, never NULL. */
  if (shotTo !== undefined) {
    const shotId = shotTo;
    if (shotId) {
      const shot = await getShot(shotId);
      if (!shot) return NextResponse.json({ error: "That shot is gone." }, { status: 404 });
      const gen = await getGeneration(id);
      if (!gen) return NextResponse.json({ error: "No such render." }, { status: 404 });
      const version = gen.kind === "audio" ? null : await nextVersion(shotId);
      await db().execute({
        sql: `UPDATE generations SET shot_id=?, version=COALESCE(?, version), project_id=COALESCE(?, project_id), updated_at=? WHERE id=?`,
        args: [shotId, version, shot.projectId, Date.now(), id],
      });
    } else {
      await db().execute({
        sql: `UPDATE generations SET shot_id=NULL, version=1, updated_at=? WHERE id=?`,
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
  return NextResponse.json({ ok: true, ...(review ? { review } : {}) });
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
  const asked = (await params).id;
  /* The sample's takes are nobody's to delete: 403 view-only for everyone, before the private-board answer (lib/demo/readonly.server.ts). */
  {
    const inTake = (await db().execute({ sql: "SELECT project_id FROM generations WHERE id=?", args: [asked] })).rows[0];
    const { sampleWriteRefusal } = await import("@/lib/demo/readonly.server");
    const refusedSample = await sampleWriteRefusal(inTake?.project_id == null ? null : String(inTake.project_id));
    if (refusedSample) return refusedSample;
  }
  const id = await takeIdFor(got.user, asked);
  await workbenchReady();
  await mediaDeletionReady();
  const refused = await notYours(got.user, id);
  if (refused) return refused;
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
