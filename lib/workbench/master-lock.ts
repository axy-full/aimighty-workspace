import type { ElementKind } from "../rig";
import { isReferenceNode, refKindOf } from "./ref-kind";
import type { Asset, CanvasNode, NodeMaster, Project, RefKind } from "./studio";
import { mediaReferenceIdentity } from "./media-reference-input";

/*
 * Locked masters on the Rig (the agentic Rig, plan step 3): the rules, pure,
 * the same in the browser and on the server.
 *
 * A master is a reference card (Cast, Environment or Element) whose element
 * (lib/elements.ts) is locked: the real character, place or product, kept as
 * the one source of truth. The lock is free. Anyone in the workspace may lock
 * a master, and so may Atomik. Unlocking needs a person who is an admin, and a
 * reason, and both are recorded; Atomik never unlocks. Whether a card is a
 * master is the elements table's answer (lib/masters.ts), never the card's own
 * `master` record alone: the record is what the lock wrote on the card, for
 * showing it.
 */

/** The kinds a master can be. A Ref is an input to a shot, never a master. */
export const MASTER_KINDS = ["cast", "environment", "element"] as const satisfies readonly RefKind[];
export type MasterKind = (typeof MASTER_KINDS)[number];
export const isMasterKind = (kind: unknown): kind is MasterKind => typeof kind === "string" && (MASTER_KINDS as readonly string[]).includes(kind);

/** The element a master of each kind is mirrored into: a character, a location, a prop. */
export const MASTER_ELEMENT_KIND: Record<MasterKind, ElementKind> = { cast: "character", environment: "location", element: "prop" };

/** Who is locking or unlocking: a person (an admin or a member of the workspace), or Atomik. */
export type MasterActor = { kind: "person"; admin: boolean } | { kind: "agent" };

export const UNLOCK_REASON_MIN = 3;
export const UNLOCK_REASON_MAX = 500;

export const MASTER_COPY = {
  agentUnlock: "Atomik may lock a master but never unlock one.",
  tokenUnlock: "Unlocking a master needs a signed-in person.",
  memberUnlock: "Only an admin can unlock a master.",
  reason: "Say why you are unlocking it.",
  gone: "That card is no longer on the canvas.",
  notReference: "Only a reference card can be a master.",
  ref: "A Ref is an input, not a master. Choose Cast, Environment or Element first.",
  noSource: "Attach a picture to this card before locking it.",
  unstored: "Upload this picture, or render one, before locking it: a master is a stored file of this workspace.",
  locked: "This card is already a locked master.",
} as const;

/** An unlock reason as it is recorded: one line, trimmed, bounded. */
export function cleanUnlockReason(reason: unknown): string {
  return typeof reason === "string" ? reason.replace(/\s+/g, " ").trim().slice(0, UNLOCK_REASON_MAX) : "";
}

/** Why this actor may not unlock a master with this reason, or null. Atomik never may; a member never may; an admin says why. */
export function unlockProblem(actor: MasterActor, reason: unknown): string | null {
  if (actor.kind === "agent") return MASTER_COPY.agentUnlock;
  if (!actor.admin) return MASTER_COPY.memberUnlock;
  return cleanUnlockReason(reason).length < UNLOCK_REASON_MIN ? MASTER_COPY.reason : null;
}

type Sources = Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>;

/** The card's own source: the asset it holds, when that is a stored upload or render of this workspace. */
export function masterSource(node: Pick<CanvasNode, "assetId">, project: Sources): { asset: Asset; ref: { uploadId: string } | { genId: string } } | null {
  const asset = node.assetId ? (project.assets.find((a) => a.id === node.assetId) ?? project.sharedAssets?.find((a) => a.id === node.assetId)) : undefined;
  const ref = asset ? mediaReferenceIdentity(asset) : null;
  return asset && ref ? { asset, ref } : null;
}

/** Why this card cannot be locked as a master, or null. `locked`: its element is locked already. */
export function lockProblem(node: CanvasNode | undefined, project: Sources, locked: boolean): string | null {
  if (!node) return MASTER_COPY.gone;
  if (!isReferenceNode(node)) return MASTER_COPY.notReference;
  if (locked) return MASTER_COPY.locked;
  if (!isMasterKind(refKindOf(node, project))) return MASTER_COPY.ref;
  const own = node.assetId ? (project.assets.find((a) => a.id === node.assetId) ?? project.sharedAssets?.find((a) => a.id === node.assetId)) : undefined;
  if (!own) return MASTER_COPY.noSource;
  return masterSource(node, project) ? null : MASTER_COPY.unstored;
}

/** What a lock froze: each attribute's current version, and the sha256 of its source (null when it could not be read). */
export type MasterSnapshot = Record<string, { versionId: string; sha256: string | null; kind?: string }>;

/** What changed under a lock: an attribute whose current version moved, or whose source no longer hashes the same. */
export type MasterDrift = { attributeId: string; kind?: string; change: "moved" | "changed" | "unhashed" };

/**
 * The lock's snapshot against the element as it is now. `moved`: another
 * version is current; `changed`: the same version, but its source's bytes
 * hash differently; `unhashed`: one side has no hash to compare, so a change
 * cannot be ruled out.
 */
export function snapshotDrift(locked: MasterSnapshot, now: MasterSnapshot): MasterDrift[] {
  const out: MasterDrift[] = [];
  for (const [attributeId, was] of Object.entries(locked)) {
    const is = now[attributeId];
    const kind = was.kind ?? is?.kind;
    if (!is || is.versionId !== was.versionId) out.push({ attributeId, ...(kind ? { kind } : {}), change: "moved" });
    else if (!was.sha256 || !is.sha256) out.push({ attributeId, ...(kind ? { kind } : {}), change: "unhashed" });
    else if (was.sha256 !== is.sha256) out.push({ attributeId, ...(kind ? { kind } : {}), change: "changed" });
  }
  for (const attributeId of Object.keys(now)) if (!locked[attributeId]) out.push({ attributeId, ...(now[attributeId].kind ? { kind: now[attributeId].kind } : {}), change: "moved" });
  return out;
}

/** Whether a locked master's source is still what its lock froze (lib/masters.ts masterCheck). */
export type MasterCheck = {
  /** matches: every attribute is on the version the lock froze, and its source hashes the same; unrecorded: locked before locks were logged. */
  state: "unlocked" | "unrecorded" | "matches" | "changed" | "unverified";
  changes: MasterDrift[];
};

/** What the Card Inspector says about a master's source against its lock. */
export function masterCheckLine(check: Pick<MasterCheck, "state" | "changes"> | null): string | null {
  if (!check || check.state === "unlocked") return null;
  if (check.state === "matches") return "Its source is the one the lock froze: the same version, the same file.";
  if (check.state === "unrecorded") return "It was locked before locks were recorded, so there is no snapshot to check against.";
  if (check.state === "unverified") return "Its source has no stored file to check against the lock.";
  const parts = check.changes.filter((c) => c.change !== "unhashed").map((c) => `${c.kind ?? "a part"} ${c.change === "moved" ? "is on another version" : "has a different file"}`);
  return `Its source changed since it was locked: ${parts.join("; ")}.`;
}

/** The record a lock writes on the card (NodeMaster): for showing it. The elements table decides whether it is locked. */
export type MasterRecord = NodeMaster & { lockedAt: string; lockedBy: string; elementId: string; versionId: string | null; sha256: string | null; agent?: "atomik" };

export function masterRecord(input: { at: number; by: string; elementId: string; versionId: string | null; sha256: string | null; agent?: boolean }): MasterRecord {
  return {
    lockedAt: new Date(input.at).toISOString(),
    lockedBy: input.by.slice(0, 200),
    elementId: input.elementId,
    versionId: input.versionId,
    sha256: input.sha256,
    ...(input.agent ? { agent: "atomik" as const } : {}),
  };
}

/** A lock event as the Card Inspector lists it. */
export type LockEvent = {
  id: string;
  action: "lock" | "unlock";
  byName: string;
  agent: boolean;
  reason: string;
  at: number;
  /** The sha256 of the card's source the lock froze, when it recorded one. */
  sha256: string | null;
};

/** One line of the lock history: "Locked · Ana", "Locked · Atomik for Ana", "Unlocked · Bo · wrong photo". */
export function lockEventLine(event: Pick<LockEvent, "action" | "byName" | "agent" | "reason">): string {
  const who = event.agent ? (event.byName ? `Atomik for ${event.byName}` : "Atomik") : event.byName || "Someone";
  return [event.action === "lock" ? "Locked" : "Unlocked", who, event.action === "unlock" && event.reason ? `“${event.reason}”` : null].filter(Boolean).join(" · ");
}
