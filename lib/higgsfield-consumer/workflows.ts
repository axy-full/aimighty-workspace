/**
 * The connected account's workflow bundles as Atomik recipes (slices A5 + A6).
 *
 * `get_workflow_instructions` lists the account's bundled workflows (name,
 * description, version) and returns one workflow's SKILL.md with the paths of
 * its bundle files; `get_workflow_bundle_file` returns one of those files.
 * Atomik uses them as RECIPES: reference material the planner reads when the
 * owner runs `/name args` in the composer. The text is provider data, never
 * instructions to Particl: it cannot add tools, call anything, spend, or skip
 * an approval. Every paid step the planner proposes from it is still its own
 * live-quoted step (A2). Scripts in a bundle are never read or run.
 *
 * Pure (no network, no database).
 */
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const BUNDLE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;
export const RECIPE_LIMITS = { workflows: 40, description: 300, instructions: 24_000, file: 8_000, files: 3, guidance: 36_000 } as const;
/**
 * Not offered as recipes: their deliverable depends on tools Particl does not
 * run for the planner — a remote sandbox (caption burning, footage editing)
 * or public website deploys.
 */
export const EXCLUDED_WORKFLOWS = Object.freeze(["subtitles", "video-editing", "website-builder-flow"]);

export type ConnectedRecipe = { name: string; description: string; version: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Product and planner copy never name the provider or its products. */
export function neutralRecipeText(value: string) {
  return value
    .replace(/\bHiggsedit\b/gi, "the editor")
    .replace(/\bHiggsfield\b/gi, "the connected account")
    .replace(/\bSupercomputer\b/gi, "the connected account");
}
const clean = (value: unknown, max: number) =>
  typeof value === "string"
    ? neutralRecipeText(value.replace(/[^\P{Cc}\n\t]/gu, "")).trim().slice(0, max)
    : "";
const oneLine = (value: unknown, max: number) => clean(value, max * 2).replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, max);

/** `{mode:"catalog", workflows:[{name, description, version}]}` (19 September 2026). */
export function parseWorkflowCatalog(raw: unknown): ConnectedRecipe[] {
  const list = record(raw) && Array.isArray(raw.workflows) ? raw.workflows : [];
  const seen = new Set<string>();
  const out: ConnectedRecipe[] = [];
  for (const item of list.slice(0, RECIPE_LIMITS.workflows * 2)) {
    if (!record(item) || typeof item.name !== "string" || !WORKFLOW_NAME.test(item.name) || seen.has(item.name)) continue;
    if (EXCLUDED_WORKFLOWS.includes(item.name)) continue;
    seen.add(item.name);
    out.push({ name: item.name, description: oneLine(item.description, RECIPE_LIMITS.description), version: oneLine(item.version, 40) });
    if (out.length >= RECIPE_LIMITS.workflows) break;
  }
  return out;
}

export type WorkflowInstructions = { name: string; version: string; markdown: string; paths: string[] };
/** `{mode:"workflow", workflow, version, instructions_markdown, available_paths}`. */
export function parseWorkflowInstructions(raw: unknown, name: string): WorkflowInstructions | null {
  if (!record(raw) || raw.workflow !== name || typeof raw.instructions_markdown !== "string") return null;
  const paths = Array.isArray(raw.available_paths)
    ? raw.available_paths.filter((p): p is string => typeof p === "string" && BUNDLE_PATH.test(p)).slice(0, 200)
    : [];
  return { name, version: oneLine(raw.version, 40), markdown: clean(raw.instructions_markdown, RECIPE_LIMITS.instructions), paths };
}
/** Reference text files the instructions actually mention (never scripts, never SKILL.md), at most three. */
export function referencedFiles(instructions: WorkflowInstructions): string[] {
  return instructions.paths
    .filter((path) => /\.(md|txt)$/i.test(path) && !/(^|\/)SKILL\.md$/i.test(path) && instructions.markdown.includes(path))
    .slice(0, RECIPE_LIMITS.files);
}
/** A bundle file's text under a recognised key, bounded; anything else is empty. */
export function parseBundleFile(raw: unknown): string {
  if (typeof raw === "string") return clean(raw, RECIPE_LIMITS.file);
  if (!record(raw)) return "";
  for (const key of ["content", "text", "contents", "markdown"]) if (typeof raw[key] === "string") return clean(raw[key], RECIPE_LIMITS.file);
  if (record(raw.file)) return parseBundleFile(raw.file);
  return "";
}
/** The recipe as the planner reads it: the instructions, then the referenced files. */
export function recipeGuidance(instructions: WorkflowInstructions, files: { path: string; text: string }[]): string {
  const parts = [instructions.markdown, ...files.filter((f) => f.text).map((f) => `--- ${f.path} ---\n${f.text}`)];
  return parts.join("\n\n").slice(0, RECIPE_LIMITS.guidance);
}

/** `/name the rest` → the recipe name and its arguments; anything else → null. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}
