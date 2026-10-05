"use client";
import type { Project } from "@/lib/workbench/studio";
import type { ControlRoomPageId } from "./pages";

/**
 * Atomik's control room entry (stream 8): Approvals, Activity, Memory and Skills, at their own addresses. STUB seeded by
 * the shell (stream 1); stream 8 replaces this file with ControlRoom and flips `landed` in lib/control-room/routes.ts.
 * Never mounted while `landed` is false: those addresses keep showing today's page.
 */
export function ControlRoom(props: { page: ControlRoomPageId; project?: Project | null }) {
  void props;
  return null;
}
