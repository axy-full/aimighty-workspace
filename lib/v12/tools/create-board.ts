/**
 * `create_board`: make a board, the tool behind Home's "+ New project" (demo plan, rule 11). Free. The button, an outside agent over MCP
 * and Atomik make a board the same way: one builder (`boardFromInput`, here), one saved draft (POST /api/boards → saveDraft).
 *
 * Pure: no React, no database (tests/unit/v12-create-board.spec.ts).
 */
import { DEFAULT_LENGTH } from "@/components/graphite/home/home-model";
import { seededProject, PROJECT_NAME_MAX_LENGTH, type CreateSeed } from "@/lib/shell/create-project";
import { newProjectBoard, NEW_PROJECT_NAME } from "@/lib/v12/board/new-project";
import type { Project } from "@/lib/workbench/studio";

/**
 * The tool, declared beside its handler (docs/particl-sow-2026-10-04.md § 4.3; the registry is not code yet, so each PR declares its own, as
 * lib/sarvamTools.ts does). Who may call it: a person or an agent; a token needs the render scope (it writes a draft), and a read-only token is
 * refused. It spends nothing and asks no one for a price.
 */
export const CREATE_BOARD_TOOL = {
  id: "create_board",
  kind: "app" as const,
  route: "/api/boards",
  provider: null,
  needs: [] as string[],
  price: "free" as const,
  who: "anyone with a render-scope token, or a signed-in person" as const,
  inputs: {
    name: "up to 80 characters (optional; the brief names it when there is none)",
    brief: "up to 30,000 characters (optional)",
    aspect: "16:9, 9:16, 1:1 or 4:5 (optional)",
    length: "a length such as 30 s (optional)",
    kind: "film (default: the demo's steps on the rail)",
  },
  output: "the board's id; its rail starts with the demo's steps",
};

export type BoardInput = { name?: unknown; brief?: unknown; aspect?: unknown; length?: unknown; kind?: unknown };
export type BoardBuilt = { ok: true; project: Project } | { ok: false; error: string };

const LENGTH = /^\d{1,3}(?:\.\d)?\s?(?:s|sec|min)$/i;

/** The board an input asks for, or why not. Only a Film board, with the demo's rail, is made here for now. */
export function boardFromInput(input: BoardInput, nameFor: (brief: string) => string | null = () => null): BoardBuilt {
  if (input.kind != null && input.kind !== "film") return { ok: false, error: "Only a film board can be made this way for now." };
  if (input.name != null && typeof input.name !== "string") return { ok: false, error: "The name is words." };
  if (input.brief != null && typeof input.brief !== "string") return { ok: false, error: "The brief is words." };
  if (input.aspect != null && !["16:9", "9:16", "1:1", "4:5"].includes(String(input.aspect))) return { ok: false, error: "Pick 16:9, 9:16, 1:1 or 4:5." };
  if (input.length != null && !(typeof input.length === "string" && LENGTH.test(input.length.trim()))) return { ok: false, error: "Give a length such as 30 s." };
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";
  const named = typeof input.name === "string" ? input.name.trim() : "";
  const name = (named || nameFor(brief) || NEW_PROJECT_NAME).slice(0, PROJECT_NAME_MAX_LENGTH);
  const seed: CreateSeed = {
    ...(brief ? { brief } : {}),
    ...(typeof input.aspect === "string" ? { aspect: input.aspect } : {}),
    /* The button's own default length when none is asked, so one board is the same whoever makes it. */
    deliverables: typeof input.length === "string" ? input.length.trim() : DEFAULT_LENGTH,
    boardKind: "studio",
    ...newProjectBoard(),
  };
  return { ok: true, project: seededProject(name, seed) };
}
