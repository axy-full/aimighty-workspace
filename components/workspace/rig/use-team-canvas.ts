"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Json, LiveMap, Room } from "@liveblocks/client";
import { draftBody, draftRequest } from "@/lib/workbench/draft-request";
import type { Asset, CanvasNode, Project } from "@/lib/workbench/studio";
import { diffForTeam, joinTeamCanvas, orderedIds, withTeamCanvas, type TeamPatch } from "@/lib/workbench/team-canvas-model";

/*
 * The Rig's team canvas in the browser (owner, 2026-09-24: one shared canvas).
 *
 *  - Opening a project reads its production's canvas and folds it into the
 *    person's draft; nodes the canvas never saw join it (nothing vanishes).
 *  - Every local edit is sent to the server as a per-node patch, so the
 *    canvas is the same for everyone the next time they open it.
 *  - When the owner's Liveblocks key is set, the same edits also travel
 *    through a live room and land in teammates' open windows at once, with
 *    their cursors, selections and drags shown on the graph.
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
  presence: (patch: Partial<Presence>) => void;
  /** Sends any waiting canvas edit now. The draft save awaits it, so the canvas is never older than the saved draft. */
  flush: () => Promise<void>;
};

const API = "/api/workbench/team-canvas";
const SAVE_MS = 500;
const RETRY_MS = 5000;
/** Browsers cap the bodies of keepalive requests in flight at 64 KB. */
const KEEPALIVE_MAX = 60_000;
const plain = <T,>(value: T): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Several edits between saves travel as one patch: the last write of each node wins. */
function mergePatches(a: TeamPatch | null, b: TeamPatch): TeamPatch {
  if (!a) return b;
  const nodes = new Map(a.upsertNodes.map((n) => [n.id, n]));
  const removed = new Set(a.removeNodes);
  for (const n of b.upsertNodes) { nodes.set(n.id, n); removed.delete(n.id); }
  for (const id of b.removeNodes) { removed.add(id); nodes.delete(id); }
  const assets = new Map(a.upsertAssets.map((x) => [x.id, x]));
  for (const x of b.upsertAssets) assets.set(x.id, x);
  return { upsertNodes: [...nodes.values()], removeNodes: [...removed], upsertAssets: [...assets.values()], order: b.order ?? a.order, at: b.at };
}

/** The canvas with this window's not-yet-sent edits laid over it. */
function overlay(canvas: Canvas, patch: TeamPatch | null): Canvas {
  if (!patch) return canvas;
  const nodes = { ...canvas.nodes }, assets = { ...canvas.assets };
  const removedIds = new Set(canvas.removedIds);
  for (const n of patch.upsertNodes) { nodes[n.id] = n; removedIds.delete(n.id); }
  for (const id of patch.removeNodes) { delete nodes[id]; removedIds.add(id); }
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
  const retry = useRef<() => void>(() => {});
  const pending = useRef<TeamPatch | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef<string | null>(null);
  const room = useRef<LiveRoom | null>(null);
  const writeLive = useRef<((patch: TeamPatch) => void) | null>(null);
  /* Edits made before the canvas has loaded: kept, laid over it on arrival, then sent. */
  const early = useRef<{ pid: string; patch: TeamPatch } | null>(null);

  const send = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const patch = pending.current, pid = joined.current;
    if (!patch || !pid) return;
    pending.current = null;
    try {
      const json = JSON.stringify({ productionId: pid, upsertNodes: patch.upsertNodes, removeNodes: patch.removeNodes, upsertAssets: patch.upsertAssets, order: patch.order });
      /* A small edit rides keepalive, so it survives the page closing or reloading mid-send
         (the save that runs as the page hides starts it; an ordinary request would be cancelled). */
      const request = json.length <= KEEPALIVE_MAX ? { headers: { "Content-Type": "application/json" }, body: json } : await draftBody(json);
      await draftRequest(API, scope, { method: "PATCH", headers: request.headers, body: request.body, keepalive: json.length <= KEEPALIVE_MAX });
    } catch {
      /* Keep it and try again; a later edit rides along. */
      pending.current = mergePatches(patch, pending.current ?? { ...patch, upsertNodes: [], removeNodes: [], upsertAssets: [], order: null });
      timer.current = setTimeout(() => retry.current(), RETRY_MS);
    }
  }, [scope]);
  useEffect(() => { retry.current = () => void send(); }, [send]);

  /* A page being closed or reloaded sends the waiting edit now, or the older canvas would win on the next open. */
  useEffect(() => {
    const onHide = () => { if (pending.current) void send(); };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [send]);

  const queue = useCallback((patch: TeamPatch) => {
    pending.current = mergePatches(pending.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), SAVE_MS);
  }, [send]);

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
      /* What this window changed while the canvas was loading is newer than the canvas: it wins. */
      const mine = early.current?.pid === productionId ? early.current.patch : null;
      early.current = null;
      const canvas: Canvas = overlay(saved.canvas ?? { nodes: {}, assets: {}, order: [], removedIds: [] }, mine);
      const joinedCanvas = joinTeamCanvas(draft, canvas, Date.now());
      const outgoing = mine && joinedCanvas.patch ? mergePatches(mine, joinedCanvas.patch) : mine ?? joinedCanvas.patch;
      joined.current = productionId;
      fold((p) => joinTeamCanvas(p, canvas, Date.now()).project);
      if (outgoing) queue(outgoing);
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

      const write = (patch: TeamPatch) => live.batch(() => {
        const nodes = root.get("nodes"), assets = root.get("assets");
        for (const n of patch.upsertNodes) nodes.set(n.id, plain(n));
        for (const id of patch.removeNodes) nodes.delete(id);
        for (const a of patch.upsertAssets) assets.set(a.id, plain(a));
        if (patch.order) root.set("order", patch.order);
      });
      writeLive.current = write;

      /* Alone in the room: the saved canvas is the truth, so the room starts from it.
         With teammates already editing: the room is ahead of the server; take it, then add what only this draft had. */
      const truth = { ...canvas, ...(outgoing ? {
        nodes: { ...canvas.nodes, ...Object.fromEntries(outgoing.upsertNodes.map((n) => [n.id, n])) },
        assets: { ...canvas.assets, ...Object.fromEntries(outgoing.upsertAssets.map((a) => [a.id, a])) },
        order: outgoing.order ?? canvas.order,
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
    queue(patch);
  }, [queue]);

  const presence = useCallback((patch: Partial<Presence>) => { room.current?.updatePresence(patch); }, []);

  return { mode, peers, publish, presence, flush: send };
}
