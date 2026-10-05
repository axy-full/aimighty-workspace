"use client";
/*
 * LOCAL STUB in stream 3's worktree only — never committed. Stream 1 owns this file (s01-plan § 1: useNewInterface()
 * reads useSession().workspace?.newInterface). Here the new interface is always on, so the board can be run.
 */
export function useNewInterface(): boolean {
  return true;
}
