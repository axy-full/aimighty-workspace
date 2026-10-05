"use client";
import { useMemo } from "react";
import { useShell, type Shell } from "@/lib/shell/state";
import type { BoardKind } from "./home-model";

/** The board's address on the shell (stream 1's `goBoard`, which itself falls back to today's page for a board that has not landed). */
type BoardNav = {
  goBoard?: (to: { kind?: BoardKind; frame?: string; start?: "script" }) => void;
  goControlRoom?: (page: "approvals" | "runs" | "saved-skills" | "memory") => void;
  openAtomik?: (mode?: "panel" | "how") => void;
};

/**
 * Where Home sends a project once it is open. The shell's `goBoard` when it has one; until then the page
 * each kind opens today, the same pages stream 1's fallback rows name: a Studio board's Rig (its Brief for
 * a script), Ads' setup, Social's history.
 */
export function useHomeNav() {
  const shell = useShell() as Shell & BoardNav;
  return useMemo(() => ({
    openBoard(kind?: BoardKind, start?: "script") {
      if (typeof shell.goBoard === "function") {
        shell.goBoard({ ...(kind && kind !== "studio" ? { kind } : {}), ...(start ? { start } : {}) });
        return;
      }
      if (kind === "ads") shell.goSuite("business", "setup");
      else if (kind === "social") shell.goSuite("viral", "history");
      else if (start === "script") shell.goSuite("studio", "brief");
      else if (kind === "studio") shell.goSuite("studio", "rig");
      else shell.goProject();
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
