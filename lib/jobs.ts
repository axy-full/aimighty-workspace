import { db, ready, now } from "./db";
import { fetchTask } from "./ark";
import { storeVideo } from "./storage";
import { costUsd, effectiveRate } from "./models";

export type Generation = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  arkTaskId: string | null;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  status: string;
  sourceUrl: string | null;
  storedUrl: string | null;
  totalTokens: number | null;
  costUsd: number | null;
  error: string | null;
  createdBy: string;
  authorName: string | null;
  createdAt: number;
  updatedAt: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToGeneration(r: any): Generation {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
    arkTaskId: r.ark_task_id ?? null,
    model: r.model,
    prompt: r.prompt,
    params: JSON.parse(r.params || "{}"),
    status: r.status,
    sourceUrl: r.source_url ?? null,
    storedUrl: r.stored_url ?? null,
    totalTokens: r.total_tokens ?? null,
    costUsd: r.cost_usd ?? null,
    error: r.error ?? null,
    createdBy: r.created_by ?? "",
    authorName: r.author_name ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const SELECT = `
  SELECT g.*, p.name AS project_name, u.name AS author_name
  FROM generations g
  LEFT JOIN projects p ON p.id = g.project_id
  LEFT JOIN users    u ON u.id = g.created_by
`;

export async function listGenerations(opts: {
  projectId?: string | null;
  createdBy?: string | null;
  limit?: number;
  search?: string;
} = {}): Promise<Generation[]> {
  await ready();
  const where: string[] = [];
  const args: any[] = [];

  if (opts.projectId !== undefined && opts.projectId !== null) {
    where.push("g.project_id = ?");
    args.push(opts.projectId);
  }
  if (opts.createdBy) {
    where.push("g.created_by = ?");
    args.push(opts.createdBy);
  }
  if (opts.search) {
    where.push("LOWER(g.prompt) LIKE ?");
    args.push(`%${opts.search.toLowerCase()}%`);
  }

  const sql = `${SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY g.created_at DESC
    LIMIT ?`;
  args.push(opts.limit ?? 200);

  const rs = await db().execute({ sql, args });
  return rs.rows.map(rowToGeneration);
}

export async function getGeneration(genId: string): Promise<Generation | null> {
  await ready();
  const rs = await db().execute({
    sql: `${SELECT} WHERE g.id = ? LIMIT 1`,
    args: [genId],
  });
  return rs.rows[0] ? rowToGeneration(rs.rows[0]) : null;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Poll Ark for one generation and reconcile our row.
 * On first sight of success: copy the MP4 into our own storage and
 * snapshot the cost using the rate in effect right now.
 */
export async function syncGeneration(gen: Generation): Promise<Generation> {
  if (TERMINAL.has(gen.status) && (gen.status !== "succeeded" || gen.storedUrl)) {
    return gen;
  }
  if (!gen.arkTaskId) return gen;

  let task;
  try {
    task = await fetchTask(gen.arkTaskId);
  } catch (e) {
    // Transient poll failure: leave the row alone, report it upward.
    return { ...gen, error: (e as Error).message };
  }

  let storedUrl = gen.storedUrl;
  let cost = gen.costUsd;
  let rate: number | null = null;

  if (task.status === "succeeded" && task.videoUrl && !storedUrl) {
    try {
      storedUrl = await storeVideo(gen.id, task.videoUrl);
    } catch (e) {
      // Keep the (expiring) Ark URL as a fallback rather than losing the render.
      // Loud in the logs: a silent failure here cost us two near-lost videos.
      console.error(`storeVideo failed for ${gen.id}:`, (e as Error).message);
      storedUrl = null;
    }
    if (task.totalTokens != null) {
      // Rate depends on the output resolution tier, not just the model.
      const res = String((gen.params as { resolution?: string }).resolution ?? "720p");
      rate = effectiveRate(gen.model, res);
      cost = rate == null ? null : costUsd(task.totalTokens, rate);
    }
  }

  const ts = now();
  await db().execute({
    sql: `UPDATE generations
          SET status=?, source_url=?, stored_url=?, total_tokens=?,
              cost_usd=COALESCE(?, cost_usd),
              rate_usd_per_m=COALESCE(?, rate_usd_per_m),
              error=?, updated_at=?
          WHERE id=?`,
    args: [
      task.status,
      task.videoUrl,
      storedUrl,
      task.totalTokens,
      cost,
      rate,
      task.error,
      ts,
      gen.id,
    ],
  });

  return {
    ...gen,
    status: task.status,
    sourceUrl: task.videoUrl,
    storedUrl,
    totalTokens: task.totalTokens,
    costUsd: cost,
    error: task.error,
    updatedAt: ts,
  };
}

/** Sync every job that isn't finished yet. Called by list views. */
export async function syncPending(limit = 12): Promise<void> {
  await ready();
  const rs = await db().execute({
    sql: `${SELECT} WHERE g.status NOT IN ('succeeded','failed','cancelled')
             OR (g.status='succeeded' AND g.stored_url IS NULL)
          ORDER BY g.created_at DESC LIMIT ?`,
    args: [limit],
  });
  await Promise.allSettled(rs.rows.map((r) => syncGeneration(rowToGeneration(r))));
}
