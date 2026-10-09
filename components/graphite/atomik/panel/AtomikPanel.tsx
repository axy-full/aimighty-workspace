"use client";
import type { Project } from "@/lib/workbench/studio";

/**
 * Atomik's panel entry (stream 7): `&atomik=1` (the panel) and `&atomik=how` (Ask Atomik how), over any screen. STUB
 * seeded by the shell (stream 1); stream 7 replaces this file with AtomikPanel and flips `landed` in
 * components/graphite/atomik/panel/routes.ts. Never mounted while `landed` is false.
 */
export type AtomikPanelProps = {
  mode: "panel" | "how";
  /** The words handed to the panel (`&q=`), or null. */
  query: string | null;
  onClose: () => void;
  scope: string;
  project: Project | null;
};

export function AtomikPanel(props: AtomikPanelProps) {
  void props;
  return null;
}
