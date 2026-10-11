"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Generation } from "@/lib/jobs";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { WALL_CANDIDATES, WALL_READ, WALL_TILES, wallTiles, type WallTile } from "@/lib/v12/home";

/**
 * The wall's tiles: this workspace's newest finished stills and clips, from today's takes list (GET /api/jobs, one read per kind, scoped to
 * the workspace and person by the request scope; `sync=0` so a Home read never starts a reconcile). Read once Home opens,
 * and again when a take lands (the jobs bus). Never another workspace's work, never sample work.
 */
export type WallState = { status: "loading" | "ready" | "error"; tiles: WallTile[]; /** A tile whose picture would not load: it leaves the wall and the next take takes its place. */ markBroken: (id: string) => void; /** How many takes the wall left out because their picture would not load (this read). */ unloaded: number };
type Read = { status: "loading" | "ready" | "error"; candidates: WallTile[] };

export function useWall(scope: string): WallState {
  const fetcher = useScopedFetch(scope);
  const [state, setState] = useState<Read>({ status: "loading", candidates: [] });
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const markBroken = useCallback((id: string) => setBroken((was) => (was.has(id) ? was : new Set(was).add(id))), []);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("particl:jobs", bump);
    return () => window.removeEventListener("particl:jobs", bump);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    /* Stills and clips only (the route takes one kind a read), so sounds never crowd the wall's six out. */
    const read = (kind: "image" | "video") => {
      const query = new URLSearchParams({ status: "succeeded", kind, limit: String(WALL_READ), sync: "0" });
      return fetcher(`/api/jobs?${query}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
        const body = (await response.json().catch(() => null)) as { generations?: Generation[] } | null;
        if (!response.ok || !Array.isArray(body?.generations)) throw new Error("unread");
        return body.generations;
      });
    };
    Promise.all([read("image"), read("video")])
      .then(([stills, clips]) => { if (!controller.signal.aborted) { setBroken((was) => (was.size ? new Set() : was)); setState({ status: "ready", candidates: wallTiles([...stills, ...clips], WALL_CANDIDATES) }); } })
      .catch(() => { if (!controller.signal.aborted) setState((s) => ({ status: s.candidates.length ? "ready" : "error", candidates: s.candidates })); });
    return () => controller.abort();
  }, [fetcher, tick]);
  const tiles = useMemo(() => state.candidates.filter((tile) => !broken.has(tile.id)).slice(0, WALL_TILES), [state.candidates, broken]);
  const unloaded = useMemo(() => state.candidates.filter((tile) => broken.has(tile.id)).length, [state.candidates, broken]);
  return { status: state.status, tiles, markBroken, unloaded };
}
