import { z } from "zod";
import type { Client, Transaction } from "@libsql/client";
import { db, ready, now } from "@/lib/db";
import { workbenchTransaction } from "./records";
import { canvasAssetSchema, canvasNodeSchema } from "./studio-schema";
import { PROJECT_JSON_BYTES, PROJECT_LIMITS } from "./project-limits";
import { applyTeamPatch, emptyTeamCanvas, parseTeamCanvas, type TeamCanvas, type TeamPatch } from "./team-canvas-model";

/*
 * The one Rig canvas a production's team shares, in the workspace database.
 * Liveblocks carries edits between open windows as they happen; this row is
 * where the canvas lives, so it opens the same with or without a live room,
 * and it travels with the rest of the workspace's data.
 */

const initialized = new WeakMap<Client, Promise<void>>();
export async function teamCanvasReady() {
  await ready();
  const client = db();
  let pending = initialized.get(client);
  if (!pending) {
    pending = client
      .execute(`CREATE TABLE IF NOT EXISTS workbench_team_canvas (
        production_id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL,
        updated_by TEXT, updated_at INTEGER NOT NULL
      )`)
      .then(() => {})
      .catch((error) => {
        initialized.delete(client);
        throw error;
      });
    initialized.set(client, pending);
  }
  await pending;
}

export class TeamCanvasError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const teamPatchSchema = z.object({
  productionId: z.string().regex(ID),
  upsertNodes: z.array(canvasNodeSchema).max(PROJECT_LIMITS.nodes),
  /* Per node an edit changed: the fields it changed (only those are written). */
  fields: z.record(z.string().max(100), z.array(z.string().max(100)).max(200)).optional(),
  /* Nodes an edit made: they join unless the canvas already holds them. */
  made: z.array(z.string().max(100)).max(PROJECT_LIMITS.nodes).optional(),
  removeNodes: z.array(z.string().max(100)).max(PROJECT_LIMITS.nodes),
  upsertAssets: z.array(canvasAssetSchema).max(PROJECT_LIMITS.assets),
  order: z.array(z.string().max(100)).max(PROJECT_LIMITS.nodes).nullable(),
});

/** The room a production's canvas is edited in, scoped to its workspace. */
export const teamRoomFor = (workspaceId: string, productionId: string) => `particl:${workspaceId}:${productionId}`;

export function productionOfRoom(room: string, workspaceId: string): string | null {
  const prefix = `particl:${workspaceId}:`;
  if (!room.startsWith(prefix)) return null;
  const id = room.slice(prefix.length);
  return ID.test(id) ? id : null;
}

/** Only a production of this workspace has a team canvas. */
export async function requireProduction(productionId: string) {
  if (!ID.test(productionId)) throw new TeamCanvasError("Open a saved project first.", 400);
  await ready();
  const row = (await db().execute({ sql: "SELECT id FROM projects WHERE id=?", args: [productionId] })).rows[0];
  if (!row) throw new TeamCanvasError("That project is not in this workspace.", 404);
}

export async function readTeamCanvas(productionId: string): Promise<{ canvas: TeamCanvas; revision: number } | null> {
  await teamCanvasReady();
  const row = (await db().execute({ sql: "SELECT body,revision FROM workbench_team_canvas WHERE production_id=?", args: [productionId] })).rows[0];
  if (!row) return null;
  let body: unknown = null;
  try { body = JSON.parse(String(row.body)); } catch { body = null; }
  return { canvas: parseTeamCanvas(body), revision: Number(row.revision) };
}

/** Fold one person's edit in. The server's clock orders writes, so a skewed laptop clock cannot win. */
export async function patchTeamCanvas(productionId: string, patch: Omit<TeamPatch, "at">, userId: string) {
  await teamCanvasReady();
  return workbenchTransaction(async (tx) => (await applyTeamCanvasPatch(tx, productionId, patch, userId))!);
}

/**
 * The same fold inside a transaction the caller holds (a draft save carries
 * its node edits to the canvas this way). With `onlyIfShared`, a production
 * whose canvas nobody has opened yet is left alone: the first Rig to open it
 * brings the whole draft.
 */
export async function applyTeamCanvasPatch(tx: Transaction, productionId: string, patch: Omit<TeamPatch, "at">, userId: string, onlyIfShared = false) {
  const row = (await tx.execute({ sql: "SELECT body,revision FROM workbench_team_canvas WHERE production_id=?", args: [productionId] })).rows[0];
  if (!row && onlyIfShared) return null;
  let current = emptyTeamCanvas();
  if (row) { try { current = parseTeamCanvas(JSON.parse(String(row.body))); } catch { current = emptyTeamCanvas(); } }
  const at = Math.max(now(), ...Object.values(current.stamps).map(Number).filter(Number.isFinite));
  const next = applyTeamPatch(current, { ...patch, at });
  if (Object.keys(next.nodes).length > PROJECT_LIMITS.nodes)
    throw new TeamCanvasError(`A canvas holds at most ${PROJECT_LIMITS.nodes.toLocaleString("en-US")} nodes.`, 413);
  const body = JSON.stringify(next);
  if (body.length > PROJECT_JSON_BYTES) throw new TeamCanvasError("This canvas has reached the 24 MB project limit.", 413);
  const revision = (row ? Number(row.revision) : 0) + 1;
  await tx.execute({
    sql: `INSERT INTO workbench_team_canvas(production_id,body,revision,updated_by,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(production_id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    args: [productionId, body, revision, userId, now()],
  });
  return { canvas: next, revision };
}
