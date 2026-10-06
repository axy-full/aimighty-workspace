import type { Client } from "@libsql/client";
import { db, ready, now, id as newId } from "../db";

/**
 * Jobs an outside agent prepares (Gaps B, MCP tokens: "outside agents prepare jobs and a person approves each").
 *
 * A token with the `prepare` scope can write one thing: a prepared job, the words and settings of a render. It is
 * not a take, holds nothing, reserves nothing and is never sent to an engine. A person sees it in Settings ›
 * Connections and either opens it in Make, where Make shows its price and the person presses it (the approval, on
 * the ordinary paid path), or dismisses it. Dismissed and opened jobs are marked, never erased.
 *
 * Stored in the workspace's own database, in a table made on first use (additive).
 */
import type { PreparedJob, PreparedState } from "./prepared-words";
export type { PreparedJob, PreparedState } from "./prepared-words";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS prepared_jobs (
    id TEXT PRIMARY KEY, token_id TEXT NOT NULL, prompt TEXT NOT NULL, settings_json TEXT NOT NULL,
    project TEXT, state TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL,
    decided_by TEXT, decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS prepared_jobs_state ON prepared_jobs(state, created_at DESC)`,
];
const initialized = new WeakMap<Client, Promise<void>>();
export async function preparedReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client)) initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((e) => { initialized.delete(client); throw e; }));
  await initialized.get(client);
}

export class PreparedError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "PreparedError"; }
}

/** At most this many waiting at once per token, so a runaway agent can't bury the people who approve. */
export const WAITING_LIMIT = 50;
const RESOLUTIONS = ["480p", "720p", "1080p"];
const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

export type PreparedInput = { prompt?: unknown; model?: unknown; duration?: unknown; resolution?: unknown; ratio?: unknown; audio?: unknown; project?: unknown };

/** Validates what an agent sends: the same fields render_shot takes, nothing that names a price or a person. */
export function cleanPrepared(input: PreparedInput) {
  const prompt = typeof input.prompt === "string" ? input.prompt.replace(/\u0000/g, "").trim().slice(0, 4000) : "";
  if (!prompt) throw new PreparedError("Describe the shot to prepare.");
  const model = String(input.model ?? "2.5").includes("2.0") ? "2.0" as const : "2.5" as const;
  const duration = Number(input.duration ?? 5);
  if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new PreparedError("Duration is whole seconds, 1 to 30.");
  const resolution = String(input.resolution ?? "1080p");
  if (!RESOLUTIONS.includes(resolution)) throw new PreparedError(`Resolution is one of ${RESOLUTIONS.join(", ")}.`);
  const ratio = String(input.ratio ?? "16:9");
  if (!RATIOS.includes(ratio)) throw new PreparedError(`Ratio is one of ${RATIOS.join(", ")}.`);
  const audio = input.audio === true;
  const project = typeof input.project === "string" && input.project.trim() ? input.project.trim().slice(0, 120) : null;
  return { prompt, model, duration, resolution, ratio, audio, project };
}

/** Files a prepared job for a `prepare` token. Nothing is priced, held or sent. */
export async function prepareJob(input: PreparedInput, token: { id: string; scope: string } | undefined, at = now()): Promise<PreparedJob> {
  if (!token || token.scope !== "prepare") throw new PreparedError("Only a token made to prepare jobs files one; a person uses Make.", 403);
  const clean = cleanPrepared(input);
  await preparedReady();
  const waiting = await db().execute({ sql: `SELECT COUNT(*) AS n FROM prepared_jobs WHERE token_id = ? AND state = 'waiting'`, args: [token.id] });
  if (Number(waiting.rows[0]?.n ?? 0) >= WAITING_LIMIT) throw new PreparedError(`This token already has ${WAITING_LIMIT} jobs waiting for a person. Wait for them to be approved or dismissed.`, 429);
  const id = newId("prep");
  const { prompt, project, ...settings } = clean;
  await db().execute({
    sql: `INSERT INTO prepared_jobs (id, token_id, prompt, settings_json, project, state, created_at) VALUES (?,?,?,?,?,'waiting',?)`,
    args: [id, token.id, prompt, JSON.stringify(settings), project, at],
  });
  return (await preparedJobs({ id }))[0];
}

/** Prepared jobs, newest first: by state, by token, or one by id. Token names come from this workspace's own table. */
export async function preparedJobs(filter: { state?: PreparedState; tokenId?: string; id?: string } = {}): Promise<PreparedJob[]> {
  await preparedReady();
  const where: string[] = [], args: string[] = [];
  if (filter.state) { where.push("p.state = ?"); args.push(filter.state); }
  if (filter.tokenId) { where.push("p.token_id = ?"); args.push(filter.tokenId); }
  if (filter.id) { where.push("p.id = ?"); args.push(filter.id); }
  const rs = await db().execute({
    sql: `SELECT p.*, t.name AS token_name FROM prepared_jobs p LEFT JOIN api_tokens t ON t.id = p.token_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC LIMIT 100`,
    args,
  });
  return rs.rows.map((r) => {
    const s = ((): Record<string, unknown> => { try { return JSON.parse(String(r.settings_json)); } catch { return {}; } })();
    return {
      id: String(r.id), tokenId: String(r.token_id), tokenName: r.token_name == null ? null : String(r.token_name), prompt: String(r.prompt),
      model: s.model === "2.0" ? "2.0" : "2.5", duration: Number(s.duration ?? 5), resolution: String(s.resolution ?? "1080p"), ratio: String(s.ratio ?? "16:9"),
      audio: s.audio === true, project: r.project == null ? null : String(r.project),
      state: r.state === "opened" ? "opened" : r.state === "dismissed" ? "dismissed" : "waiting",
      createdAt: Number(r.created_at), decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    };
  });
}

/** A person opens it in Make (where they approve it at its price) or dismisses it. Marked, never erased. */
export async function decidePrepared(id: string, state: unknown, personId: string, at = now()): Promise<boolean> {
  if (state !== "opened" && state !== "dismissed") throw new PreparedError("Open it in Make, or dismiss it.");
  await preparedReady();
  const rs = await db().execute({ sql: `UPDATE prepared_jobs SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'waiting'`, args: [state, personId, at, id] });
  return (rs.rowsAffected ?? 0) > 0;
}
