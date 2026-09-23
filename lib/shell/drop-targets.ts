"use client";
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
