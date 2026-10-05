"use client";
import type { ReactNode } from "react";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import type { ProjectActions } from "../FirstRun";

/**
 * The phone's entry (stream 10): its own header, screens and tab bar at compact widths, or in a centred 390 px frame for
 * `device=phone`. STUB seeded by the shell (stream 1); stream 10 replaces this file with PhoneApp and flips `landed` in
 * components/graphite/phone/routes.ts. Never mounted while `landed` is false: the phone keeps today's chrome.
 */
export type PhoneAppProps = {
  scope: string;
  account: WorkspaceAccount | null;
  /** The shell's projects read (lib/workspace/data › useProjects). */
  data: { status: "loading" | "ready" | "error"; projects: ProjectActions["projects"]; error: string | null; retry: () => void };
  project: Project | null;
  items: LibraryEntry[];
  library: ProjectLibrary;
  projectActions: ProjectActions;
  /** The shell's own page for an address the phone has no screen for (Settings, an old page), drawn under the phone's header. Null on the phone's own screens. */
  page?: { title: string; body: ReactNode } | null;
};

export function PhoneApp(props: PhoneAppProps) {
  void props;
  return null;
}
