"use client";
import { useEffect, useState } from "react";
import type { Generation } from "@/lib/jobs";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { WALL_READ, wallTiles, type WallTile } from "@/lib/v12/home";

/**
 * The wall's tiles: this workspace's newest finished stills and clips, from today's takes list (GET /api/jobs, scoped to
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
    const query = new URLSearchParams({ status: "succeeded", limit: String(WALL_READ), sync: "0" });
    fetcher(`/api/jobs?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { generations?: Generation[] } | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(body?.generations)) { setState((s) => ({ status: s.tiles.length ? "ready" : "error", tiles: s.tiles })); return; }
        setState({ status: "ready", tiles: wallTiles(body.generations) });
      })
      .catch(() => { if (!controller.signal.aborted) setState((s) => ({ status: s.tiles.length ? "ready" : "error", tiles: s.tiles })); });
    return () => controller.abort();
  }, [fetcher, tick]);
  return state;
}
