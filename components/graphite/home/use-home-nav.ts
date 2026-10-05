"use client";
import { useMemo } from "react";
import { useShell, type Shell } from "@/lib/shell/state";
import type { BoardKind } from "./home-model";

/** The shell's helpers Home uses; the board and the control room are for every workspace, so each exists. */
type BoardNav = {
  goControlRoom?: (page: "approvals" | "runs" | "saved-skills" | "memory") => void;
  openAtomik?: (mode?: "panel" | "how") => void;
};

/**
 * Where Home sends a project once it is open: the shell's `goBoard` (the board is the whole production, so no kind has a
 * page of its own to fall back to). With `atomik`, the docked Atomik panel opens in the same move.
 */
export function useHomeNav() {
  const shell = useShell() as Shell & BoardNav;
  return useMemo(() => ({
    openBoard(kind?: BoardKind, start?: "script", atomik?: boolean) {
      shell.goBoard({ ...(kind && kind !== "studio" ? { kind } : {}), ...(start ? { start } : {}), ...(atomik ? { atomik: true } : {}) });
    },
    /** The control room's Approvals (today's Atomik › Approvals page until it lands). */
    openApprovals() {
      if (typeof shell.goControlRoom === "function") shell.goControlRoom("approvals");
      else shell.goSuite("atomik", "approvals");
    },
    /** Atomik's panel over the board, once stream 7's lands; until then the board's own run card shows the plan. */
    openAtomik() {
      if (typeof shell.openAtomik === "function") shell.openAtomik("panel");
    },
    /** Top up: Settings › Plan & credits, the existing request flow. */
    openCredits() {
      shell.goWorkspace("credits");
    },
  }), [shell]);
}
