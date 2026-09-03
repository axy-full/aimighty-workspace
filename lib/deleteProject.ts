"use client";

import { appConfirm, appAlert } from "@/components/dialog";
import { announceChange } from "./changes";

/**
 * Ask, then delete a project. Its renders stay in the library as Unfiled
 * (and on the ledger); what was filed under it goes with it. Returns
 * whether it happened, so the caller can reset the selection and refresh.
 */
export async function confirmDeleteProject(id: string, name: string, renders?: number | null): Promise<boolean> {
  const kept = renders
    ? `Its ${renders} render${renders === 1 ? "" : "s"} stay in the library as Unfiled, and their cost stays on the ledger. `
    : "";
  const ok = await appConfirm(`Delete ${name}?`,
    `${kept}Shots, cast and notes filed under it go with it.`,
    { confirmLabel: "Delete project", danger: true });
  if (!ok) return false;
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    await appAlert("Couldn't delete the project", json.error);
    return false;
  }
  announceChange();
  return true;
}
