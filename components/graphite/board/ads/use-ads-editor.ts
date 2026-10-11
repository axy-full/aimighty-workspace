"use client";
import { useMemo } from "react";
import type { RigContext } from "@/components/workspace/rig/RigProvider";
import type { DraftEditor } from "@/lib/workspace/use-draft-editor";

/*
 * The board's one draft editor, as the Business tools' helpers (own-kit: changeBrief, adoptEntry, uploadToDraft,
 * importToDraft) expect it. The board edits the project through the Rig's provider (ctx.rig), the revision-checked,
 * auto-saving draft every card of the board shares: a second editor on the same project would race it. So the
 * Ads cards and panels edit through this thin view of the Rig, never a second copy of the draft.
 */
const SAVE_WORDS: Record<RigContext["saveState"], string> = { saved: "Saved", saving: "Saving", error: "Not saved" };

export function riggedEditor(rig: Pick<RigContext, "status" | "project" | "saveState" | "saveError" | "apply" | "save">): DraftEditor {
  return {
    status: rig.status === "ready" ? "ready" : rig.status === "error" ? "error" : "loading",
    project: rig.project,
    saveState: SAVE_WORDS[rig.saveState],
    error: rig.saveError ?? "",
    notice: "",
    change: (fn) => { rig.apply((project) => fn(project)); },
    ensureSaved: () => rig.save(),
    refresh: async () => { await rig.save(); return rig.project; },
    reload: () => undefined,
  };
}

export function useRiggedEditor(rig: RigContext): DraftEditor {
  const { status, project, saveState, saveError, apply, save } = rig;
  return useMemo(() => riggedEditor({ status, project, saveState, saveError, apply, save }), [status, project, saveState, saveError, apply, save]);
}
