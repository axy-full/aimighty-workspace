import type { BoardCard } from "@/lib/board/types";
import type { Project } from "@/lib/workbench/studio";
import { shotRows } from "./model";
import type { DocData } from "../plan/derive";

/*
 * The Script stage's cards (the new interface; docs/redesign-plan.md "one board, four lenses"): the script as a document card, then one text card per beat of the
 * beat sheet in the sheet's order, under the board's "script" region. They are exactly the rows the List shows (`shotRows`, the same function), so the Canvas
 * never shows less than the List does. Pure and cheap: called with every other card on every change.
 */
export const SCRIPT_CARD_ID = "doc:script";
export const beatCardId = (shotId: string) => `beat:${shotId}`;

export function deriveScript(project: Pick<Project, "script" | "production">): BoardCard<DocData>[] {
  const cards: BoardCard<DocData>[] = [];
  const script = project.script ?? "";
  if (script.trim()) {
    cards.push({
      id: SCRIPT_CARD_ID, kind: "doc", region: "script", order: 0, state: "done",
      summary: `Script · ${script.trim().length.toLocaleString("en-US")} characters`,
      data: { variant: "script", text: script },
    });
  }
  const sheet = project.production?.beats;
  const headings = new Map((sheet?.scenes ?? []).map((scene) => [scene.id, scene.heading.trim()]));
  for (const row of shotRows(sheet)) {
    const heading = headings.get(row.sceneId);
    cards.push({
      id: beatCardId(row.id), kind: "doc", region: "script", order: row.index, state: row.action.trim() ? "done" : "empty",
      data: { variant: "beat", shotId: row.id, title: heading ? `${row.n} · ${heading}` : `Shot ${row.n}`, text: row.action },
    });
  }
  return cards;
}
