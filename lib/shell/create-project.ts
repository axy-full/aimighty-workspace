import { newProject, type Project } from "@/lib/workbench/studio";
import { FLAVORS } from "@/lib/v12/board/kinds";
import type { BoardKindId } from "./screens";

/** What a template or a brief hands the shell when it makes a project (Home's templates, ⌘K's "new …"). Every field is optional. */
export type CreateSeed = { brief?: string; aspect?: string; deliverables?: string; boardKind?: BoardKindId;
  /** The new interface's board kind and the rail a person edited before pressing Start (lib/v12/board/kinds.ts, stages.ts). */
  boardFlavor?: NonNullable<Project["boardFlavor"]>; boardStages?: Project["boardStages"] };

import { ASPECT_OPTIONS } from "@/lib/settingValues";
const ASPECTS: readonly string[] = ASPECT_OPTIONS;
export const PROJECT_NAME_MAX_LENGTH = 80;

/**
 * Today's new project (lib/workbench/studio.ts › newProject) with a seed's fields set: the same shape, the same save
 * route (PUT /api/workbench/projects), so a seeded project is an ordinary draft. Only what the seed names is changed.
 * `boardKind` is read by the board (lib/board/kind.ts) once the project schema carries it; until then it is dropped
 * by the schema on save and the board reads the kind from the project's own data, as for any older draft.
 */
export function seededProject(name: string, seed: CreateSeed = {}): Project {
  const project = newProject(name.trim().slice(0, PROJECT_NAME_MAX_LENGTH) || "Untitled");
  if (typeof seed.brief === "string" && seed.brief.trim()) project.brief = seed.brief.slice(0, 30_000);
  if (typeof seed.aspect === "string" && ASPECTS.includes(seed.aspect)) project.aspect = seed.aspect;
  if (typeof seed.deliverables === "string" && seed.deliverables.trim()) project.deliverables = seed.deliverables.slice(0, 10_000);
  if (seed.boardKind === "studio" || seed.boardKind === "ads" || seed.boardKind === "social") (project as Project & { boardKind?: BoardKindId }).boardKind = seed.boardKind;
  if (seed.boardFlavor && FLAVORS.includes(seed.boardFlavor)) project.boardFlavor = seed.boardFlavor;
  if (Array.isArray(seed.boardStages) && seed.boardStages.length) project.boardStages = seed.boardStages.slice(0, 24);
  return project;
}

/**
 * The shape a new board starts in when the person did not pick one: the workspace's default (Settings › Defaults, the
 * `defaultAspect` setting), read once from GET /api/settings, or null for Particl's own. A failed read is no default, never a
 * blocked board.
 */
export async function workspaceAspect(read: (url: string) => Promise<Response>): Promise<string | null> {
  try {
    const response = await read("/api/settings");
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { settings?: Record<string, unknown> } | null;
    const value = body?.settings?.defaultAspect;
    return typeof value === "string" && ASPECTS.includes(value) ? value : null;
  } catch { return null; }
}
