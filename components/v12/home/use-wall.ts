"use client";
import { useEffect, useState } from "react";
import type { Generation } from "@/lib/jobs";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { WALL_READ, wallTiles, type WallTile } from "@/lib/v12/home";

/**
 * The wall's tiles: this workspace's newest finished stills and clips, from today's takes list (GET /api/jobs, one read per kind, scoped to
 * the workspace and person by the request scope; `sync=0` so a Home read never starts a reconcile). Read once Home opens,
 * and again when a take lands (the jobs bus). Never another workspace's work, never sample work.
 */
export type WallState = { status: "loading" | "ready" | "error"; tiles: WallTile[] };

export function useWall(scope: string): WallState {
  const fetcher = useScopedFetch(scope);
  const [state, setState] = useState<WallState>({ status: "loading", tiles: [] });
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
      .then(([stills, clips]) => { if (!controller.signal.aborted) setState({ status: "ready", tiles: wallTiles([...stills, ...clips]) }); })
      .catch(() => { if (!controller.signal.aborted) setState((s) => ({ status: s.tiles.length ? "ready" : "error", tiles: s.tiles })); });
    return () => controller.abort();
  }, [fetcher, tick]);
  return state;
}
