"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Json, LiveMap, Room } from "@liveblocks/client";
import { DraftRequestError, draftBody, draftRequest } from "@/lib/workbench/draft-request";
import type { Project } from "@/lib/workbench/studio";
import {
  catchUpForTeam, diffForTeam, joinTeamCanvas, landedWrite, orderedIds, overlay, plainJson, roomPeer, withTeamCanvas, writeRoom,
  type RoomDrag, type RoomPeer, type RoomPoint, type RoomStorage, type TeamCanvasView, type TeamPatch,
} from "@/lib/workbench/team-canvas-model";
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
 *    their cursors, selections and drags shown on the graph. The server
 *    writes changes it makes (a Tidy, Atomik's work) into the same room, by
 *    the same rules (writeRoom), and shows Atomik there while it works.
 *  - With no live room, a window checks every few seconds whether the server
 *    changed the canvas, and folds it in when it did, this window's unsent
 *    edits laid over it.
 *  - What another save brought into the draft (a merge) catches the canvas
 *    up only where it still holds what this window had (catchUpForTeam): a
 *    save the canvas missed reaches it, and a teammate's later edit stands.
 *  - An edit waiting to be sent belongs to the production it was made on, and
 *    goes there, whatever is open when it is sent.
 */

/** A teammate in the room, or Atomik (`agent`: the server's writer, shown with what it is doing). */
export type Peer = RoomPeer;
export type Point = RoomPoint;
export type Drag = RoomDrag;
type Presence = { cursor: Point | null; selected: string | null; drag: Drag | null };
type Storage = { nodes: LiveMap<string, Json>; assets: LiveMap<string, Json>; order: string[]; serverMade?: { [id: string]: string } };
type Canvas = TeamCanvasView;
type LiveRoom = Room<Presence, Storage>;
/** The newest change the server made to the canvas (canvas-ops-log latestServerChange). */
export type ServerChange = { seq: number; at: number; what: string; agent: boolean };
export type TidyOutcome = { ok: true; moved: number; live: "sent" | "waiting" | "off" } | { ok: false; error: string };

export type TeamCanvasApi = {
  /** "live" once in the room; "saved" when only the server copy is shared; "off" before a project is saved. */
  mode: "off" | "saved" | "live";
  peers: Peer[];
  /** A server change this window just folded in (no live room): shown to the person for a few seconds. */
  server: ServerChange | null;
  publish: (before: Project, after: Project) => void;
  /** What another save brought in (before → after the merge): onto the canvas only where it still holds `before`'s values. */
  catchUp: (before: Project, after: Project) => void;
  presence: (patch: Partial<Presence>) => void;
  /** Sends any waiting canvas edit now. The draft save awaits it, so the canvas is never older than the saved draft. */
  flush: () => Promise<void>;
  /** Lays the board out on the server, for everyone at once. Free. */
  tidy: () => Promise<TidyOutcome>;
  /** Folds in what the server just changed (Atomik's build), now rather than at the next check. A live room brings it by itself. */
  refresh: () => Promise<void>;
};

const API = "/api/workbench/team-canvas";
const SAVE_MS = 500;
const RETRY_MS = 5000;
/** With no live room: how often a window checks whether the server changed the canvas. */
const POLL_MS = 5000;
/** How long a server change folded in here stays named on screen. */
const SHOWN_MS = 15_000;
/** Browsers cap the bodies of keepalive requests in flight at 64 KB. */
const KEEPALIVE_MAX = 60_000;
const EMPTY: Canvas = { nodes: {}, assets: {}, order: [], removedIds: [] };
const TIDY_FAILED = "The board could not be tidied. Try again.";

function isServerChange(value: unknown): value is ServerChange {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.seq === "number" && typeof v.at === "number" && typeof v.what === "string" && typeof v.agent === "boolean";
}

function isCanvasAnswer(value: unknown): value is { canvas: Canvas | null; room: string | null; revision: number; server?: ServerChange | null } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== "number" || !("canvas" in v) || (v.room !== null && typeof v.room !== "string")) return false;
  if (v.canvas === null) return v.revision === 0;
  const c = v.canvas as Record<string, unknown> | undefined;
  return !!c && typeof c === "object" && typeof c.nodes === "object" && typeof c.assets === "object" && Array.isArray(c.order) && Array.isArray(c.removedIds);
}

/** The light check's answer (GET ?head=1): the revision, and the newest server change. */
function isHeadAnswer(value: unknown): value is { head: true; revision: number; server: ServerChange | null } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.head === true && typeof v.revision === "number" && (v.server === null || isServerChange(v.server));
}

function readStorage(root: { get: <K extends keyof Storage>(key: K) => Storage[K] }): Canvas {
  const nodes: Canvas["nodes"] = {}, assets: Canvas["assets"] = {};
  root.get("nodes").forEach((value, id) => { nodes[id] = value as unknown as Canvas["nodes"][string]; });
  root.get("assets").forEach((value, id) => { assets[id] = value as unknown as Canvas["assets"][string]; });
  return { nodes, assets, order: [...(root.get("order") ?? [])], removedIds: [] };
}

/** The live room as writeRoom writes it: the same writer the server's push uses (lib/workbench/canvas-push.ts). */
function roomOf(root: { get: <K extends keyof Storage>(key: K) => Storage[K]; set: <K extends keyof Storage>(key: K, value: Storage[K]) => void }): RoomStorage {
  const nodes = root.get("nodes"), assets = root.get("assets");
  return {
    nodes: { get: (id) => nodes.get(id), set: (id, value) => nodes.set(id, value as Json), delete: (id) => { nodes.delete(id); } },
    assets: { get: (id) => assets.get(id), set: (id, value) => assets.set(id, value as Json) },
    order: () => root.get("order") ?? [],
    setOrder: (order) => root.set("order", order),
    serverMade: () => root.get("serverMade") ?? {},
    setServerMade: (made) => root.set("serverMade", made),
  };
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
  const [shown, setShown] = useState<{ pid: string; change: ServerChange } | null>(null);
  const server = productionId && shown?.pid === productionId ? shown.change : null;
  const { toast } = useWorkspace();
  const retry = useRef<() => void>(() => {});
  /* Each waiting edit keeps the production it was made in: it is sent there and nowhere else. */
  const [outbox] = useState(() => new TeamOutbox());
  /* Catch-ups (what merges brought in), by production, in order: sent before this window's own edits, never folded into them. */
  const catchUps = useRef(new Map<string, TeamPatch[]>());
  /* Edits on their way to the server now, by production: laid over a canvas read meanwhile, so the read never undoes them. */
  const inflight = useRef(new Map<string, TeamPatch[]>());
  /* The newest server change this window has folded in, by production. */
  const serverSeen = useRef<{ pid: string; seq: number } | null>(null);
  const shownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joined = useRef<string | null>(null);
  const room = useRef<LiveRoom | null>(null);
  const writeLive = useRef<((patch: TeamPatch) => void) | null>(null);
  /* Edits made before the canvas has loaded: kept, laid over it on arrival, then sent. */
  const early = useRef<{ pid: string; patch: TeamPatch } | null>(null);

  const send = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const post = async (pid: string, patch: TeamPatch) => {
      const going = inflight.current.get(pid) ?? [];
      going.push(patch);
      inflight.current.set(pid, going);
      try {
        const json = JSON.stringify({ productionId: pid, upsertNodes: patch.upsertNodes, fields: patch.fields ?? {}, made: patch.made ?? [], removeNodes: patch.removeNodes, upsertAssets: patch.upsertAssets, order: patch.order, ...(patch.expect ? { expect: patch.expect } : {}) });
        /* A small edit rides keepalive, so it survives the page closing or reloading mid-send
           (the save that runs as the page hides starts it; an ordinary request would be cancelled). */
        const request = json.length <= KEEPALIVE_MAX ? { headers: { "Content-Type": "application/json" }, body: json } : await draftBody(json);
        await draftRequest(API, scope, { method: "PATCH", headers: request.headers, body: request.body, keepalive: json.length <= KEEPALIVE_MAX });
      } finally {
        const left = (inflight.current.get(pid) ?? []).filter((p) => p !== patch);
        if (left.length) inflight.current.set(pid, left);
        else inflight.current.delete(pid);
      }
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
  }, [scope, outbox, toast]);
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

  /** A server change seen here: remembered, and named on screen for a moment when it was folded in just now. */
  const noteServer = useCallback((pid: string, change: ServerChange | null | undefined, show: boolean) => {
    if (!change) return;
    const seen = serverSeen.current?.pid === pid ? serverSeen.current.seq : 0;
    if (change.seq <= seen) return;
    serverSeen.current = { pid, seq: change.seq };
    if (!show) return;
    setShown({ pid, change });
    if (shownTimer.current) clearTimeout(shownTimer.current);
    shownTimer.current = setTimeout(() => setShown((s) => (s?.change === change ? null : s)), SHOWN_MS);
  }, []);
  useEffect(() => () => { if (shownTimer.current) clearTimeout(shownTimer.current); }, []);

  /**
   * No live room: the canvas as the server holds it now, folded in with this window's own edits
   * (sent or not yet) laid over it — what the server changed arrives, and nothing made here is undone.
   */
  const foldServer = useCallback(async (pid: string) => {
    let saved: unknown;
    try { saved = await draftRequest(`${API}?productionId=${encodeURIComponent(pid)}`, scope); }
    catch { return; }
    /* Only while this window still shows that production with no live room: a room carries server changes itself. */
    if (!isCanvasAnswer(saved) || joined.current !== pid || room.current) return;
    const pending: (TeamPatch | null)[] = [...(catchUps.current.get(pid) ?? []), ...(inflight.current.get(pid) ?? []), outbox.peek(pid)];
    const canvas = pending.reduce<Canvas>((at, patch) => overlay(at, patch), saved.canvas ?? EMPTY);
    fold((p) => withTeamCanvas(p, canvas));
    noteServer(pid, isServerChange(saved.server) ? saved.server : null, true);
  }, [scope, outbox, fold, noteServer]);

  /* Open the production's canvas, fold it in, then join its live room if there is one. */
  useEffect(() => {
    if (!productionId) return;
    let cancelled = false;
    let leave: (() => void) | null = null;
    const unsubs: (() => void)[] = [];
    void (async () => {
      let saved: { canvas: Canvas | null; room: string | null; revision: number; server?: ServerChange | null };
      try { saved = await draftRequest(`${API}?productionId=${encodeURIComponent(productionId)}`, scope); }
      catch { return; }
      if (cancelled) return;
      /* Only a real canvas answer joins: anything else (a proxy page, a stub) must never seed the team canvas. */
      if (!isCanvasAnswer(saved)) return;
      const draft = current();
      if (!draft) return;
      /* What this window changed while the canvas was loading is newer than the canvas: it wins. What a merge brought in
         meanwhile lands where the canvas still holds what this window had. */
      const mine = early.current?.pid === productionId ? early.current.patch : null;
      early.current = null;
      const canvas: Canvas = [...(catchUps.current.get(productionId) ?? []), mine].reduce<Canvas>((at, patch) => overlay(at, patch), saved.canvas ?? EMPTY);
      const joinedCanvas = joinTeamCanvas(draft, canvas, Date.now());
      const outgoing = mine && joinedCanvas.patch ? mergePatches(mine, joinedCanvas.patch) : mine ?? joinedCanvas.patch;
      joined.current = productionId;
      /* The server's changes up to now are in what was just read: only later ones are folded in. */
      noteServer(productionId, isServerChange(saved.server) ? saved.server : null, false);
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

      /* The fields an edit changed, over the room's node: a teammate's edit to another field stands (and a catch-up lands
         only where the room still holds what this window had). The server's own changes reach the room the same way. */
      const write = (patch: TeamPatch) => live.batch(() => writeRoom(roomOf(root), patch));
      writeLive.current = write;

      /* Alone in the room: the saved canvas is the truth, so the room starts from it.
         With teammates already editing: the room is ahead of the server; take it, then add what only this draft had. */
      const truth = { ...canvas, ...(outgoing ? {
        nodes: { ...canvas.nodes, ...Object.fromEntries(outgoing.upsertNodes.flatMap((n) => { const next = landedWrite(canvas.nodes[n.id], undefined, n, outgoing); return next ? [[n.id, next]] : []; })) },
        assets: { ...canvas.assets, ...Object.fromEntries(outgoing.upsertAssets.map((a) => [a.id, a])) },
        order: outgoing.order ?? canvas.order,
      } : {}) };
      if (live.getOthers().length === 0) {
        live.batch(() => {
          const nodes = root.get("nodes"), assets = root.get("assets");
          nodes.forEach((_v, id) => { if (!truth.nodes[id]) nodes.delete(id); });
          for (const [id, n] of Object.entries(truth.nodes)) nodes.set(id, plainJson(n) as unknown as Json);
          for (const [id, a] of Object.entries(truth.assets)) assets.set(id, plainJson(a) as unknown as Json);
          root.set("order", orderedIds(truth));
          /* The cards the server made, so a removal a save only implied never takes one off in the room either. */
          if (truth.serverMade && Object.keys(truth.serverMade).length) root.set("serverMade", { ...(root.get("serverMade") ?? {}), ...truth.serverMade });
        });
      } else {
        fold((p) => withTeamCanvas(p, readStorage(root)));
        if (outgoing) write(outgoing);
      }

      unsubs.push(live.subscribe(root, () => fold((p) => withTeamCanvas(p, readStorage(root))), { isDeep: true }));
      unsubs.push(live.subscribe("others", (others) => {
        setJoinedState({ pid: productionId, mode: "live", peers: others.map((o) => roomPeer(o)) });
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

  /* No live room: check every few seconds whether the server changed the canvas (a Tidy, Atomik's work), and fold it in
     when it did. A light read (the revision and the newest server change); the canvas itself only when it moved. */
  useEffect(() => {
    if (!productionId || mode !== "saved") return;
    let stopped = false, busy = false;
    const tick = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const head = await draftRequest<unknown>(`${API}?productionId=${encodeURIComponent(productionId)}&head=1`, scope).catch(() => null);
        if (stopped || !isHeadAnswer(head) || !head.server) return;
        const seen = serverSeen.current?.pid === productionId ? serverSeen.current.seq : 0;
        if (head.server.seq > seen) await foldServer(productionId);
      } finally { busy = false; }
    };
    const every = setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; clearInterval(every); };
  }, [productionId, mode, scope, foldServer]);

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

  const tidy = useCallback(async (): Promise<TidyOutcome> => {
    const pid = joined.current;
    if (!pid) return { ok: false, error: "Save this project first: the board is tidied for your whole team." };
    /* This window's waiting edits reach the canvas first, so the layout starts from them. */
    await send();
    let answer: unknown;
    try {
      answer = await draftRequest<unknown>(API, scope, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tidy", productionId: pid, opId: crypto.randomUUID() }),
      });
    } catch (error) {
      return { ok: false, error: error instanceof DraftRequestError && error.status && error.status < 500 && error.status !== 401 ? error.message : TIDY_FAILED };
    }
    const v = (answer ?? {}) as { moved?: unknown; live?: unknown };
    if (typeof v.moved !== "number") return { ok: false, error: TIDY_FAILED };
    const live = v.live === "sent" || v.live === "waiting" ? v.live : "off";
    /* No live room: it is here now, and teammates' windows fold it in on their next check. With a room, the room brings it;
       one the room could not take yet goes out again on the next read of the canvas. */
    if (!room.current) await foldServer(pid);
    else if (live === "waiting") setTimeout(() => void draftRequest(`${API}?productionId=${encodeURIComponent(pid)}&head=1`, scope).catch(() => null), 3000);
    return { ok: true, moved: v.moved, live };
  }, [scope, send, foldServer]);

  const refresh = useCallback(async () => {
    const pid = joined.current;
    if (pid && !room.current) await foldServer(pid);
  }, [foldServer]);

  return { mode, peers, server, publish, catchUp, presence, flush: send, tidy, refresh };
}
