"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Json, LiveMap, Room } from "@liveblocks/client";
import { draftBody, draftRequest } from "@/lib/workbench/draft-request";
import type { Asset, CanvasNode, Project } from "@/lib/workbench/studio";
import { MASTER_NODE_FIELDS, catchUpForTeam, diffForTeam, guardMasters, joinTeamCanvas, landedRemoval, landedWrite, orderedIds, restoreHeld, withTeamCanvas, type MasterHold, type TeamPatch } from "@/lib/workbench/team-canvas-model";
import { mergePatches, sendFailure, TeamOutbox } from "@/lib/workspace/team-canvas-outbox";
import { useWorkspace } from "@/lib/workspace/state";

/*
 * The Rig's team canvas in the browser (owner, 2026-09-24: one shared canvas).
 *
 *  - Opening a project reads its production's canvas and folds it into the
 *    person's draft; nodes the canvas never saw join it (nothing vanishes).
 *  - Every local edit is sent to the server as a per-node patch — for a node
 *    that was already there, only the fields the edit changed — so the
 *    canvas is the same for everyone the next time they open it, and a
 *    teammate's edit to another field of the same node stands. (A draft save
 *    also carries its node edits to the canvas, from any editor.)
 *  - When the owner's Liveblocks key is set, the same edits also travel
 *    through a live room and land in teammates' open windows at once, with
 *    their cursors, selections and drags shown on the graph.
 *  - What another save brought into the draft (a merge) catches the canvas
 *    up only where it still holds what this window had (catchUpForTeam): a
 *    save the canvas missed reaches it, and a teammate's later edit stands.
 *  - An edit waiting to be sent belongs to the production it was made on, and
 *    goes there, whatever is open when it is sent.
 */

export type Peer = { id: number; name: string; color: string; cursor: Point | null; selected: string | null; drag: Drag | null };
export type Point = { x: number; y: number };
export type Drag = { id: string; dx: number; dy: number };
type Presence = { cursor: Point | null; selected: string | null; drag: Drag | null };
type Storage = { nodes: LiveMap<string, Json>; assets: LiveMap<string, Json>; order: string[] };
type Canvas = { nodes: Record<string, CanvasNode>; assets: Record<string, Asset>; order: string[]; removedIds: string[] };
type LiveRoom = Room<Presence, Storage>;

export type TeamCanvasApi = {
  /** "live" once in the room; "saved" when only the server copy is shared; "off" before a project is saved. */
  mode: "off" | "saved" | "live";
  peers: Peer[];
  publish: (before: Project, after: Project) => void;
  /** What another save brought in (before → after the merge): onto the canvas only where it still holds `before`'s values. */
  catchUp: (before: Project, after: Project) => void;
  presence: (patch: Partial<Presence>) => void;
  /** Sends any waiting canvas edit now. The draft save awaits it, so the canvas is never older than the saved draft. */
  flush: () => Promise<void>;
  /** The locked elements this window knows of (the masters): from the canvas's read, a lock or unlock here, and edits the server held. */
  locks: ReadonlySet<string>;
  /** A lock or unlock this window made (or learned of). */
  learnLock: (elementId: string, locked: boolean) => void;
  /** A card as the server now holds it after a lock or unlock: into the live room as it is (the server wrote it, so it is not sent again). */
  writeServer: (node: CanvasNode, fields: string[]) => void;
};

/** A held write as the route answers it: the card (or asset) as the canvas holds it comes with it. */
type HeldAnswer = MasterHold & { node?: CanvasNode; asset?: Asset };

/** A room or loaded canvas, shaped for the master guard (team-canvas-model guardMasters). */
const guardView = (canvas: Pick<Canvas, "nodes" | "assets">) => ({ nodes: canvas.nodes, assets: canvas.assets, removed: {}, retired: {} });

const API = "/api/workbench/team-canvas";
const SAVE_MS = 500;
const RETRY_MS = 5000;
/** Browsers cap the bodies of keepalive requests in flight at 64 KB. */
const KEEPALIVE_MAX = 60_000;
const plain = <T,>(value: T): Json => JSON.parse(JSON.stringify(value)) as Json;

/** The canvas with this window's not-yet-sent edits laid over it (never over a locked master: the server's own rule). */
function overlay(canvas: Canvas, sent: TeamPatch | null, locks: ReadonlySet<string>): Canvas {
  if (!sent) return canvas;
  const patch = guardMasters(guardView(canvas), sent, { locks }).patch;
  const nodes = { ...canvas.nodes }, assets = { ...canvas.assets };
  const removedIds = new Set(canvas.removedIds);
  for (const n of patch.upsertNodes) {
    const next = landedWrite(nodes[n.id], removedIds.has(n.id) ? n : undefined, n, patch);
    if (next) { nodes[n.id] = next; removedIds.delete(n.id); }
  }
  for (const id of patch.removeNodes) if (landedRemoval(nodes[id], id, patch)) { delete nodes[id]; removedIds.add(id); }
  for (const a of patch.upsertAssets) assets[a.id] = a;
  return { nodes, assets, order: patch.order ?? canvas.order, removedIds: [...removedIds] };
}

function isCanvasAnswer(value: unknown): value is { canvas: Canvas | null; room: string | null; revision: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== "number" || !("canvas" in v) || (v.room !== null && typeof v.room !== "string")) return false;
  if (v.canvas === null) return v.revision === 0;
  const c = v.canvas as Record<string, unknown> | undefined;
  return !!c && typeof c === "object" && typeof c.nodes === "object" && typeof c.assets === "object" && Array.isArray(c.order) && Array.isArray(c.removedIds);
}

function readStorage(root: { get: <K extends keyof Storage>(key: K) => Storage[K] }): Canvas {
  const nodes: Record<string, CanvasNode> = {}, assets: Record<string, Asset> = {};
  root.get("nodes").forEach((value, id) => { nodes[id] = value as unknown as CanvasNode; });
  root.get("assets").forEach((value, id) => { assets[id] = value as unknown as Asset; });
  return { nodes, assets, order: [...(root.get("order") ?? [])], removedIds: [] };
}

export function useTeamCanvas({ scope, productionId, current, fold }: {
  scope: string;
  productionId: string | null;
  /** The draft as it is now (a ref read, never stale). */
  current: () => Project | null;
  /** Applies a teammate's change to the draft without sending it back out. */
  fold: (fn: (project: Project) => Project) => void;
}): TeamCanvasApi {
  /* Keyed by production, so switching projects shows nothing stale without resetting state in an effect. */
  const [joinedState, setJoinedState] = useState<{ pid: string; mode: "saved" | "live"; peers: Peer[] } | null>(null);
  const mode: TeamCanvasApi["mode"] = productionId && joinedState?.pid === productionId ? joinedState.mode : "off";
  const peers = useMemo(() => (productionId && joinedState?.pid === productionId ? joinedState.peers : []), [productionId, joinedState]);
  const { toast } = useWorkspace();
  const retry = useRef<() => void>(() => {});
  /* Each waiting edit keeps the production it was made in: it is sent there and nowhere else. */
  const [outbox] = useState(() => new TeamOutbox());
  /* Catch-ups (what merges brought in), by production, in order: sent before this window's own edits, never folded into them. */
  const catchUps = useRef(new Map<string, TeamPatch[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef<string | null>(null);
  const room = useRef<LiveRoom | null>(null);
  const writeLive = useRef<((patch: TeamPatch) => void) | null>(null);
  /* Edits made before the canvas has loaded: kept, laid over it on arrival, then sent. */
  const early = useRef<{ pid: string; patch: TeamPatch } | null>(null);
  /* The masters this window knows of (locked elements), for the production it is on. The server decides; this only keeps
     the window from showing, or rendering with, an edit to a master the server will not take. */
  const [lockState, setLockState] = useState<{ pid: string; locks: ReadonlySet<string> } | null>(null);
  const locksRef = useRef<{ pid: string | null; locks: ReadonlySet<string> }>({ pid: null, locks: new Set() });
  const setLocks = useCallback((pid: string, next: ReadonlySet<string>) => {
    locksRef.current = { pid, locks: next };
    setLockState({ pid, locks: next });
  }, []);
  const locks = useMemo<ReadonlySet<string>>(() => (productionId && lockState?.pid === productionId ? lockState.locks : new Set()), [productionId, lockState]);
  const locksFor = useCallback((pid: string): ReadonlySet<string> => (locksRef.current.pid === pid ? locksRef.current.locks : new Set<string>()), []);
  /* Set once in the room: a card as the server holds it, written there as it is. */
  const writeTrusted = useRef<((node: CanvasNode, fields: string[] | null) => void) | null>(null);

  /* The server held part of an edit (a write to a locked master): the window learns that master, puts back what the canvas holds, and says so. */
  const handleHeld = useCallback((pid: string, held: HeldAnswer[]) => {
    const learned = held.map((h) => h.elementId).filter((id): id is string => !!id);
    if (learned.length) setLocks(pid, new Set([...locksFor(pid), ...learned]));
    const nodes = Object.fromEntries(held.filter((h) => h.nodeId && h.node).map((h) => [h.nodeId!, h.node!]));
    const assets = Object.fromEntries(held.filter((h) => h.assetId && h.asset).map((h) => [h.assetId!, h.asset!]));
    if (joined.current !== pid) return;
    /* The master as the canvas holds it, whole identity and all (its element and lock record too): so a window that
       never heard of the lock now shows the card as the master it is. */
    const back = held.map((h) => (h.nodeId && h.node && !h.removal ? { ...h, fields: [...MASTER_NODE_FIELDS] } : h));
    fold((p) => (p.productionProjectId === pid ? restoreHeld(p, back, nodes, assets) : p));
    /* A room this window wrote the held edit into takes back what the canvas holds. */
    for (const h of back) if (h.nodeId && h.node) writeTrusted.current?.(h.node, h.removal ? null : h.fields);
    const names = [...new Set(held.map((h) => (h.nodeId ? nodes[h.nodeId]?.title : null)).filter(Boolean))];
    toast(`${names.length ? names.join(", ") : "A card"} ${names.length > 1 ? "are locked masters" : "is a locked master"}: that edit did not change ${names.length > 1 ? "them" : "it"}. An admin can unlock a master.`);
  }, [fold, toast, setLocks, locksFor]);

  const send = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const post = async (pid: string, patch: TeamPatch) => {
      const json = JSON.stringify({ productionId: pid, upsertNodes: patch.upsertNodes, fields: patch.fields ?? {}, made: patch.made ?? [], removeNodes: patch.removeNodes, upsertAssets: patch.upsertAssets, order: patch.order, ...(patch.expect ? { expect: patch.expect } : {}) });
      /* A small edit rides keepalive, so it survives the page closing or reloading mid-send
         (the save that runs as the page hides starts it; an ordinary request would be cancelled). */
      const request = json.length <= KEEPALIVE_MAX ? { headers: { "Content-Type": "application/json" }, body: json } : await draftBody(json);
      const answer = await draftRequest<{ held?: unknown } | null>(API, scope, { method: "PATCH", headers: request.headers, body: request.body, keepalive: json.length <= KEEPALIVE_MAX });
      if (answer && Array.isArray(answer.held) && answer.held.length) handleHeld(pid, answer.held as HeldAnswer[]);
    };
    const batch = outbox.take(), caught = [...catchUps.current.entries()];
    catchUps.current.clear();
    if (!batch.length && !caught.length) return;
    let again = false;
    await Promise.all([...new Set([...caught.map(([pid]) => pid), ...batch.map(([pid]) => pid)])].map(async (pid) => {
      const own = batch.find(([id]) => id === pid)?.[1];
      /* What merges brought in first, then this window's own edits: a later write wins on the server's clock. */
      const queue = caught.find(([id]) => id === pid)?.[1] ?? [];
      for (let i = 0; i < queue.length; i++) {
        try { await post(pid, queue[i]); }
        catch (error) {
          /* A catch-up the server refuses would be refused again: it goes (the draft save carried the change already). */
          if (sendFailure(error) === "refused") continue;
          catchUps.current.set(pid, [...queue.slice(i), ...(catchUps.current.get(pid) ?? [])]);
          if (own) outbox.keep(pid, own);
          again = true;
          return;
        }
      }
      if (!own) return;
      try { await post(pid, own); }
      catch (error) {
        if (sendFailure(error) === "refused") {
          /* It would be refused again, and riding along it would sink every later edit: dropped.
             The draft holds it only until the production next opens, when the team canvas wins
             for every node it knows (joinTeamCanvas). A 401 is dropped too: draftRequest carries
             no status to tell it apart, and its message says to save the work before signing in. */
          toast(`Your last Rig edit did not reach the team, and the team's version replaces it when this production next opens. ${error instanceof Error ? error.message : ""}`.trim());
          return;
        }
        /* Keep it for its own production and try again, less anything a later send carried; a later edit rides along. */
        outbox.keep(pid, own);
        again = true;
      }
    }));
    if (again && !timer.current) timer.current = setTimeout(() => retry.current(), RETRY_MS);
  }, [scope, outbox, toast, handleHeld]);
  useEffect(() => { retry.current = () => void send(); }, [send]);

  /* A page being closed or reloaded sends the waiting edit now, or the older canvas would win on the next open. */
  useEffect(() => {
    const onHide = () => { if (outbox.size || catchUps.current.size) void send(); };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [send, outbox]);

  const queue = useCallback((pid: string, patch: TeamPatch) => {
    outbox.add(pid, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_MS);
  }, [send, outbox]);

  /* Open the production's canvas, fold it in, then join its live room if there is one. */
  useEffect(() => {
    if (!productionId) return;
    let cancelled = false;
    let leave: (() => void) | null = null;
    const unsubs: (() => void)[] = [];
    void (async () => {
      let saved: { canvas: Canvas | null; room: string | null; revision: number };
      try { saved = await draftRequest(`${API}?productionId=${encodeURIComponent(productionId)}`, scope); }
      catch { return; }
      if (cancelled) return;
      /* Only a real canvas answer joins: anything else (a proxy page, a stub) must never seed the team canvas. */
      if (!isCanvasAnswer(saved)) return;
      const draft = current();
      if (!draft) return;
      /* The masters on this canvas, as the elements table has them. */
      const answered = (saved as { locks?: unknown }).locks;
      const known = new Set(Array.isArray(answered) ? answered.filter((id): id is string => typeof id === "string") : []);
      setLocks(productionId, known);
      /* What this window changed while the canvas was loading is newer than the canvas: it wins (except on a locked
         master, which stays as the canvas holds it). What a merge brought in meanwhile lands where the canvas still
         holds what this window had. */
      const mine = early.current?.pid === productionId ? early.current.patch : null;
      early.current = null;
      const canvas: Canvas = [...(catchUps.current.get(productionId) ?? []), mine].reduce<Canvas>((at, patch) => overlay(at, patch, known), saved.canvas ?? { nodes: {}, assets: {}, order: [], removedIds: [] });
      const joinedCanvas = joinTeamCanvas(draft, canvas, Date.now());
      const outgoing = mine && joinedCanvas.patch ? mergePatches(mine, joinedCanvas.patch) : mine ?? joinedCanvas.patch;
      joined.current = productionId;
      fold((p) => joinTeamCanvas(p, canvas, Date.now()).project);
      if (outgoing) queue(productionId, outgoing);
      setJoinedState({ pid: productionId, mode: "saved", peers: [] });
      if (!saved.room) return;

      const { createClient, LiveMap } = await import("@liveblocks/client");
      if (cancelled) return;
      const client = createClient({
        throttle: 50,
        authEndpoint: async (roomId) => {
          const response = await fetch("/api/collab/auth", {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
            body: JSON.stringify({ room: roomId }),
          });
          return response.json();
        },
      });
      const entered = client.enterRoom<Presence, Storage>(saved.room, {
        initialPresence: { cursor: null, selected: null, drag: null },
        initialStorage: { nodes: new LiveMap<string, Json>(), assets: new LiveMap<string, Json>(), order: [] },
      });
      leave = entered.leave;
      const live = entered.room;
      const { root } = await live.getStorage();
      if (cancelled) { entered.leave(); return; }
      room.current = live;

      const write = (sent: TeamPatch) => live.batch(() => {
        const nodes = root.get("nodes"), assets = root.get("assets");
        /* Never onto a locked master this window knows of: the room holds what the server would. */
        const masters = locksFor(productionId);
        const patch = masters.size ? guardMasters(guardView(readStorage(root)), sent, { locks: masters }).patch : sent;
        /* The fields an edit changed, over the room's node: a teammate's edit to another field stands (and a catch-up lands only where the room still holds what this window had). */
        for (const n of patch.upsertNodes) {
          const next = landedWrite(nodes.get(n.id) as unknown as CanvasNode | undefined, undefined, n, patch);
          if (next) nodes.set(n.id, plain(next));
        }
        for (const id of patch.removeNodes) if (landedRemoval(nodes.get(id) as unknown as CanvasNode | undefined, id, patch)) nodes.delete(id);
        for (const a of patch.upsertAssets) assets.set(a.id, plain(a));
        if (patch.order) root.set("order", patch.order);
      });
      writeLive.current = write;
      /* A card as the server holds it (after a lock, or an edit it held): the fields named, or the card whole (`null`). */
      writeTrusted.current = (node, fields) => live.batch(() => {
        const nodes = root.get("nodes");
        const next = fields ? landedWrite(nodes.get(node.id) as unknown as CanvasNode | undefined, undefined, node, { fields: { [node.id]: fields } }) : node;
        if (next) nodes.set(node.id, plain(next));
      });

      /* Alone in the room: the saved canvas is the truth, so the room starts from it.
         With teammates already editing: the room is ahead of the server; take it, then add what only this draft had. */
      const safe = outgoing && known.size ? guardMasters(guardView(canvas), outgoing, { locks: known }).patch : outgoing;
      const truth = { ...canvas, ...(safe ? {
        nodes: { ...canvas.nodes, ...Object.fromEntries(safe.upsertNodes.flatMap((n) => { const next = landedWrite(canvas.nodes[n.id], undefined, n, safe); return next ? [[n.id, next]] : []; })) },
        assets: { ...canvas.assets, ...Object.fromEntries(safe.upsertAssets.map((a) => [a.id, a])) },
        order: safe.order ?? canvas.order,
      } : {}) };
      if (live.getOthers().length === 0) {
        live.batch(() => {
          const nodes = root.get("nodes"), assets = root.get("assets");
          nodes.forEach((_v, id) => { if (!truth.nodes[id]) nodes.delete(id); });
          for (const [id, n] of Object.entries(truth.nodes)) nodes.set(id, plain(n));
          for (const [id, a] of Object.entries(truth.assets)) assets.set(id, plain(a));
          root.set("order", orderedIds(truth));
        });
      } else {
        fold((p) => withTeamCanvas(p, readStorage(root)));
        if (outgoing) write(outgoing);
      }

      unsubs.push(live.subscribe(root, () => fold((p) => withTeamCanvas(p, readStorage(root))), { isDeep: true }));
      unsubs.push(live.subscribe("others", (others) => {
        const next = others.map((o) => {
          const info = (o.info ?? {}) as { name?: string; color?: string };
          return { id: o.connectionId, name: info.name ?? "Teammate", color: info.color ?? "#0A84FF", cursor: o.presence.cursor ?? null, selected: o.presence.selected ?? null, drag: o.presence.drag ?? null };
        });
        setJoinedState({ pid: productionId, mode: "live", peers: next });
      }));
      setJoinedState({ pid: productionId, mode: "live", peers: [] });
    })();
    return () => {
      cancelled = true;
      for (const unsub of unsubs) unsub();
      room.current = null;
      writeLive.current = null;
      writeTrusted.current = null;
      leave?.();
      void send();
      joined.current = null;
    };
    /* current/fold are ref-stable readers; re-joining on their identity would re-open the room on every render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionId, scope]);

  const publish = useCallback((before: Project, after: Project) => {
    const pid = after.productionProjectId;
    if (!pid) return;
    const patch = diffForTeam(before, after, Date.now());
    if (!patch) return;
    if (joined.current !== pid) {
      early.current = { pid, patch: mergePatches(early.current?.pid === pid ? early.current.patch : null, patch) };
      return;
    }
    writeLive.current?.(patch);
    queue(pid, patch);
  }, [queue]);

  const catchUp = useCallback((before: Project, after: Project) => {
    const pid = after.productionProjectId;
    if (!pid) return;
    const patch = catchUpForTeam(before, after, Date.now());
    if (!patch) return;
    writeLive.current?.(patch);
    catchUps.current.set(pid, [...(catchUps.current.get(pid) ?? []), patch]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_MS);
  }, [send]);

  const presence = useCallback((patch: Partial<Presence>) => { room.current?.updatePresence(patch); }, []);

  const learnLock = useCallback((elementId: string, locked: boolean) => {
    const pid = joined.current;
    if (!pid) return;
    const next = new Set(locksFor(pid));
    if (locked) next.add(elementId); else next.delete(elementId);
    setLocks(pid, next);
  }, [locksFor, setLocks]);
  const writeServer = useCallback((node: CanvasNode, fields: string[]) => { writeTrusted.current?.(node, fields); }, []);

  return { mode, peers, publish, catchUp, presence, flush: send, locks, learnLock, writeServer };
}
