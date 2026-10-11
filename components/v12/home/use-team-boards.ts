"use client";
import { useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/workspace/data";
import { useScopedFetch } from "@/lib/useScopedFetch";

/** A teammate's board as Home lists it: its maker's name, and the board as a card summary. */
export type TeamBoardCard = { summary: ProjectSummary; owner: string };

/**
 * The boards of the workspace's other members (GET /api/workbench/projects?team=1; lib/workbench/team-boards.ts), to open view-only. Read once
 * Home opens and again when the person's own list changes. An unread list is simply none: a person's own boards never wait on it.
 */
export function useTeamBoards(scope: string, key: string): TeamBoardCard[] {
  const fetcher = useScopedFetch(scope);
  const [boards, setBoards] = useState<TeamBoardCard[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetcher("/api/workbench/projects?team=1&kinds=1", { cache: "no-store", signal: controller.signal })
      .then(async (r) => (r.ok ? ((await r.json()) as { team?: { id: string; name: string; revision: number; updatedAt: number; kind?: ProjectSummary["kind"]; mine: boolean; owner: { name: string } }[] }) : null))
      .then((body) => {
        if (controller.signal.aborted || !Array.isArray(body?.team)) return;
        setBoards(body.team.filter((b) => !b.mine).map((b) => ({ summary: { id: b.id, name: b.name, revision: b.revision, updatedAt: String(b.updatedAt), kind: b.kind === "studio" || b.kind === "ads" || b.kind === "social" ? b.kind : null }, owner: b.owner.name })));
      })
      .catch(() => { /* none shown; the person's own boards are unaffected */ });
    return () => controller.abort();
  }, [fetcher, key]);
  return boards;
}
