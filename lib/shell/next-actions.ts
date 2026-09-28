import { entryFace, entryKind, type LibraryEntry } from "@/lib/workspace/library";

/**
 * Idea 12, first slice: what a take can go on to next, as a way INTO the
 * existing tool that does it — the Takes desk's Re-edit for a still, Seedance
 * Edit for a clip, Edit & Sound for a sound. Navigation only: nothing here
 * quotes, prices or sends; the tool's own button is the only paid control,
 * after its own quote. No price is ever attached to one of these. Pure.
 *
 * A still or a clip opens its tool only once its original is stored here (a
 * take that is rendering, held, failed, stopped or whose copy has not landed
 * has nothing to edit yet), and only in a saved project (the tools file their
 * result to its production). A sound opens the project's Edit & Sound, which
 * does not take the sound as an input yet — so the label says what opens, not
 * "add to the mix".
 */
export type NextActionId = "re-edit" | "edit" | "edit-sound";
export type NextAction = { id: NextActionId; label: string; opens: string; enabled: boolean; why: string | null };

type Entry = Pick<LibraryEntry, "take" | "asset" | "url" | "media">;

function gate(entry: Entry, saved: boolean): Pick<NextAction, "enabled" | "why"> {
  const face = entryFace(entry);
  if (face === "live" || face === "held") return { enabled: false, why: "It opens once it has rendered." };
  if (face === "failed" || face === "stopped") return { enabled: false, why: "It did not render, so there is nothing to edit." };
  if (face === "unavailable") return { enabled: false, why: "Its stored copy is not here yet." };
  if (!entry.url) return { enabled: false, why: "This file type cannot be edited here." };
  if (!saved) return { enabled: false, why: "Save the project first." };
  return { enabled: true, why: null };
}

export function nextActions(entry: Entry, context: { saved: boolean }): NextAction[] {
  const kind = entryKind(entry);
  if (kind === "image") return [{ id: "re-edit", label: "Re-edit", opens: "the re-edit form in Takes", ...gate(entry, context.saved) }];
  if (kind === "video") return [{ id: "edit", label: "Edit", opens: "Seedance Edit in Takes", ...gate(entry, context.saved) }];
  if (kind === "audio") return [{ id: "edit-sound", label: "Edit & Sound", opens: "Edit & Sound", enabled: true, why: null }];
  return [];
}

/** The section of the Takes desk each tool is (components/graphite/production/EditStage.tsx). */
export const NEXT_SECTION: Partial<Record<NextActionId, string>> = { "re-edit": "image", edit: "video" };

