import { db, ready, now } from "./db";
import { THREAD_LIMITS, cleanThreadTitle, threadState, threadTitle, type Thread } from "./atomikThreadsText";

export { ARCHIVED_NOTE, THREAD_LIMITS, THREAD_STATE_LABEL, cleanThreadTitle, threadState, threadTitle } from "./atomikThreadsText";
export type { Thread, ThreadState } from "./atomikThreadsText";

/**
 * Atomik threads: several conversations per project, each with its own plan.
 *
 * A thread IS an Atomik chat (`atomik_chats`): its messages, steps and
 * history were always kept per chat, so nothing moves. A project that had
 * one conversation before threads has it as its first thread, under the same
 * id, and every link and request that named it still does.
 *
 * What a project shares, every thread reads alike: the project's Memory
 * (lib/atomikMemory.ts, kept against the project, never a chat), its cast,
 * its cap and the workspace's rules and engines. What is a thread's own: its
 * conversation, its plan and steps, its thinking model, and the key each of
 * its step approvals renders under (lib/atomik.ts › threadStepRequestKey).
 * A paid step in any thread is quoted and approved on its own, as before.
 *
 * Archive hides a thread from its project's list and keeps everything in it;
 * Restore brings it back. Nothing here deletes, and nothing here spends.
 */

export class ThreadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ThreadError";
  }
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = any;
const text = (v: unknown) => (v == null || v === "" ? null : String(v));

/**
 * A project's threads (null: the ones filed under no project), newest
 * activity first: the active ones, or with `archived`, the archived ones.
 * A step planned on the connected account never waits for anyone and never
 * runs again (lib/atomikAccountStep.ts), so it moves no thread's state.
 */
export async function listThreads(projectId: string | null, viewer: string, opts: { archived?: boolean } = {}): Promise<Thread[]> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT c.id, c.project_id, c.title, c.status, c.created_by, c.created_at, c.updated_at, c.archived_at, c.archived_by,
            (SELECT COUNT(*) FROM atomik_chats o WHERE o.deleted = 0 AND o.project_id IS c.project_id
               AND (o.created_at < c.created_at OR (o.created_at = c.created_at AND o.id <= c.id))) AS number,
            (SELECT m.text FROM atomik_messages m WHERE m.chat_id = c.id AND m.role = 'user'
               ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1) AS first_ask,
            (SELECT COUNT(*) FROM atomik_messages m WHERE m.chat_id = c.id) AS messages,
            EXISTS(SELECT 1 FROM atomik_steps s WHERE s.chat_id = c.id AND s.status = 'proposed' AND s.model NOT LIKE 'connected:%') AS needs,
            EXISTS(SELECT 1 FROM atomik_steps s WHERE s.chat_id = c.id AND s.status = 'running' AND s.model NOT LIKE 'connected:%') AS rendering,
            u.name AS started_by_name, a.name AS archived_by_name
          FROM atomik_chats c
          LEFT JOIN users u ON u.id = c.created_by
          LEFT JOIN users a ON a.id = c.archived_by
          WHERE c.deleted = 0 AND c.project_id IS ? AND c.archived_at IS ${opts.archived ? "NOT NULL" : "NULL"}
          ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    args: [projectId, THREAD_LIMITS.list],
  });
  return rs.rows.map((r: Row): Thread => ({
    id: String(r.id),
    projectId: text(r.project_id),
    number: Number(r.number ?? 1),
    title: threadTitle(String(r.title ?? ""), text(r.first_ask)),
    state: threadState({ status: String(r.status ?? "idle"), needsApproval: Number(r.needs) === 1, rendering: Number(r.rendering) === 1, messages: Number(r.messages ?? 0) }),
    startedByYou: !!viewer && String(r.created_by ?? "") === viewer,
    startedByName: text(r.started_by_name),
    startedAt: Number(r.created_at ?? 0),
    lastActivityAt: Number(r.updated_at ?? 0),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    archivedByYou: !!viewer && String(r.archived_by ?? "") === viewer,
    archivedByName: text(r.archived_by_name),
  }));
}

/** A thread that is there to act on (never one hidden by the older soft delete), or null. */
async function threadRow(chatId: string): Promise<{ id: string; projectId: string | null; archivedAt: number | null } | null> {
  await ready();
  const r = (await db().execute({ sql: `SELECT id, project_id, archived_at FROM atomik_chats WHERE id = ? AND deleted = 0`, args: [chatId] })).rows[0] as Row | undefined;
  return r ? { id: String(r.id), projectId: text(r.project_id), archivedAt: r.archived_at == null ? null : Number(r.archived_at) } : null;
}

/** True when this thread is archived: nothing new is planned or approved in it until it is restored. */
export async function threadArchived(chatId: string): Promise<boolean> {
  return (await threadRow(chatId))?.archivedAt != null;
}

/**
 * Hide a thread from its project's list. Everything in it stays as it was:
 * its conversation, its plan and every step, run or not. Archiving is not
 * activity, so the thread keeps its place when it is restored.
 */
export async function archiveThread(chatId: string, by: string): Promise<void> {
  const row = await threadRow(chatId);
  if (!row) throw new ThreadError("That thread is gone.", 404);
  if (row.archivedAt != null) return;
  await db().execute({
    sql: `UPDATE atomik_chats SET archived_at = ?, archived_by = ? WHERE id = ? AND deleted = 0 AND archived_at IS NULL`,
    args: [now(), by || null, chatId],
  });
}

/** Bring an archived thread back, as it was. */
export async function restoreThread(chatId: string): Promise<void> {
  const row = await threadRow(chatId);
  if (!row) throw new ThreadError("That thread is gone.", 404);
  if (row.archivedAt == null) return;
  await db().execute({
    sql: `UPDATE atomik_chats SET archived_at = NULL, archived_by = NULL WHERE id = ? AND deleted = 0 AND archived_at IS NOT NULL`,
    args: [chatId],
  });
}

/** A person names a thread. A name is not activity: the thread keeps its place in the list. */
export async function renameThread(chatId: string, title: unknown): Promise<void> {
  const clean = cleanThreadTitle(title);
  if (!clean) throw new ThreadError("Give the thread a name.");
  const row = await threadRow(chatId);
  if (!row) throw new ThreadError("That thread is gone.", 404);
  await db().execute({ sql: `UPDATE atomik_chats SET title = ? WHERE id = ? AND deleted = 0`, args: [clean, chatId] });
}
