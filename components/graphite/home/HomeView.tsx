"use client";
import type { ProjectSummary } from "@/lib/workspace/data";
import type { CreateSeed } from "@/lib/shell/create-project";

/**
 * Home's entry (stream 2): `?view=home`. STUB seeded by the shell (stream 1) so the entry path exists; stream 2 replaces
 * this file with HomeView and flips `landed` in components/graphite/home/routes.ts. Never mounted while `landed` is
 * false: the address opens today's Studio overview instead, so no empty or invented screen is ever shown.
 */
export type HomeViewProps = {
  scope: string;
  projects: ProjectSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  onPick: (id: string) => void;
  /** Today's create path with the seed's fields set; answers the new project's id, or why it could not be made. */
  onCreate: (name: string, seed: CreateSeed) => Promise<{ id: string; productionId?: string | null } | { error: string }>;
  /** Opens the workspace's starter production; the refusal, or null. */
  onStarter: () => Promise<string | null>;
  now: number;
};

export function HomeView(props: HomeViewProps) {
  void props;
  return null;
}
