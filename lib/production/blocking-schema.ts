import { z } from "zod";
import { astraSceneSchema } from "../astra-blender/scene";
import { PROJECT_LIMITS } from "../workbench/project-limits";

/*
 * `production.blocking`: 3D blocking per Rig shot (gap screens), the record's shape and nothing else. This file is the whole of what a
 * build needs to ACCEPT the field when a project holds it (on read and on write); the screens that write it come in a later change
 * (lib/production/blocking.ts). Additive and optional: a project saved without it parses exactly as it did, and no other field changes.
 *
 * The scene is the existing 3D scene model (lib/astra-blender/scene.ts: metres, Z up). Pure and server-safe: no React, no fetch.
 */

export const MOVE_KINDS = ["hold", "push", "pull"] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];
export type Move = { kind: MoveKind; meters: number; seconds: number };

/** One entry per Rig shot, so a project can never hold more entries than it can hold shots. */
export const BLOCKING_MAX_ENTRIES = PROJECT_LIMITS.shots;
export const BLOCKING_TOO_MANY = `3D blocking is kept for up to ${BLOCKING_MAX_ENTRIES.toLocaleString("en-US")} shots in one project.`;

const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const nodeKey = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/, "A shot's id may only hold letters, numbers, - and _.")
  .refine((key) => !RESERVED.has(key), "That is not a shot id.");

export const blockingMoveSchema = z.object({ kind: z.enum(MOVE_KINDS), meters: z.number().finite().min(0).max(100), seconds: z.number().finite().min(0.5).max(600) }).strict();
export const blockingEntrySchema = z.object({
  scene: astraSceneSchema,
  move: blockingMoveSchema,
  savedAt: z.string().datetime(),
  /** The project asset holding the frame saved from the scene: the shot's reference. */
  frameAssetId: z.string().max(100).optional(),
}).strict();
const entries = z.record(nodeKey, blockingEntrySchema)
  .refine((value) => Object.keys(value).length <= BLOCKING_MAX_ENTRIES, { message: BLOCKING_TOO_MANY });
/* Zod drops a "__proto__" key while it builds a record, so a reserved key is looked for on what was sent, before the record is read. */
export const blockingSchema = z.any()
  .superRefine((raw, context) => {
    if (raw && typeof raw === "object" && Object.getOwnPropertyNames(raw).some((key) => RESERVED.has(key))) context.addIssue({ code: "custom", message: "That is not a shot id." });
  })
  .pipe(entries);

export type BlockingEntry = z.infer<typeof blockingEntrySchema>;
export type Blocking = Record<string, BlockingEntry>;
