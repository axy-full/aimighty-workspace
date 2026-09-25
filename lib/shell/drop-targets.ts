"use client";
import { hasFiles, isDroppable, readDrop } from "../drop";
/**
 * Drop targets outside the shell's own components (FINAL_SPEC §1 step 1:
 * Rig nodes). The legacy Rig list renders in both shells; the Suites shell
 * registers what a drop on a shot does, the old shell registers nothing and
 * its rows stay plain. A module-level slot keeps the legacy tree untouched.
 * The Rig's own library (Production › Rig) registers a second slot that wins
 * while it is on screen: a picture dropped on a shot becomes its input, a
 * brief its prompt text.
 */
export type ShotDrop = (assetId: string, shot: { nodeId: string; name: string }) => void;
let onShotDrop: ShotDrop | null = null;
let onRigDrop: ShotDrop | null = null;
export function setShotDropHandler(handler: ShotDrop | null) { onShotDrop = handler; }
export function setRigDropHandler(handler: ShotDrop | null) { onRigDrop = handler; }
export function shotDropHandler(): ShotDrop | null { return onRigDrop ?? onShotDrop; }

/** Files from the device dropped on a shot: the Rig library makes pictures and videos its inputs (owner, 25 September: anything droppable). */
export type ShotFilesDrop = (files: File[], shot: { nodeId: string; name: string }) => void;
let onShotFiles: ShotFilesDrop | null = null;
export function setShotFilesHandler(handler: ShotFilesDrop | null) { onShotFiles = handler; }
export function shotFilesHandler(): ShotFilesDrop | null { return onShotFiles; }

/** On dragover of a shot: can it take this? (Read at the moment, not at render — a row drawn before the Rig registered still takes drops.) */
export function canDropOnShot(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (hasFiles(dt)) return Boolean(onShotFiles);
  return Boolean(onRigDrop ?? onShotDrop) && isDroppable(dt, { files: false });
}

/**
 * A drop on a shot, from anywhere: device files go to the files slot; an
 * asset goes to the shot slot — a Rig library key (its own text/plain: a
 * brief, a project asset) as itself, anything else as its Library id.
 * Answers false when nothing took it, so the page-level drop keeps a file.
 */
export function dropOnShot(dt: DataTransfer | null, shot: { nodeId: string; name: string }): boolean {
  if (!dt) return false;
  const { ids, files } = readDrop(dt);
  if (files.length) { if (!onShotFiles) return false; onShotFiles(files, shot); return true; }
  const handler = onRigDrop ?? onShotDrop;
  let own = "";
  try { own = dt.getData("text/plain"); } catch { /* unreadable */ }
  const key = /^(brief|asset|take):/.test(own) ? own : ids[0];
  if (!handler || !key) return false;
  handler(key, shot);
  return true;
}
