import { newProject, type Project } from "@/lib/workbench/studio";
import type { BoardKindId } from "./screens";

/** What a template or a brief hands the shell when it makes a project (Home's templates, ⌘K's "new …"). Every field is optional. */
export type CreateSeed = { brief?: string; aspect?: string; deliverables?: string; boardKind?: BoardKindId };

const ASPECTS: readonly string[] = ["16:9", "9:16", "1:1", "4:5"];
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
  return project;
}
