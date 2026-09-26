"use client";
import { useEffect } from "react";
import type { GenPreset } from "./recipe";

/**
 * "Send this asset into the current composer" (FINAL_SPEC §1 step 1). The
 * Library's `+`, a right-click, or a drop can happen on any page; the
 * composer that takes references lives inside the Gen view. This is the
 * letterbox between them: senders post an asset id, the composer collects
 * whatever is waiting when it mounts and everything posted while it is up.
 */
export type ReferenceLetter = { id: string; name: string };
let waiting: ReferenceLetter[] = [];
const readers = new Set<(letter: ReferenceLetter) => void>();

export function sendReference(letter: ReferenceLetter) {
  if (readers.size) readers.forEach((read) => read(letter));
  else waiting.push(letter);
}

export function useReferenceInbox(read: ((letter: ReferenceLetter) => void) | null) {
  useEffect(() => {
    if (!read) return;
    readers.add(read);
    const backlog = waiting;
    waiting = [];
    backlog.forEach(read);
    return () => { readers.delete(read); };
  }, [read]);
}

/**
 * Recreate's letterbox: a take's whole recipe for Gen (lib/shell/recipe.ts).
 * The same rule as references — collected when Gen mounts, delivered at once
 * while it is up — except that only the newest unread recipe waits: a second
 * Recreate before Gen opens replaces the first rather than queueing behind it.
 */
let recipeWaiting: GenPreset | null = null;
const recipeReaders = new Set<(preset: GenPreset) => void>();

export function sendRecipe(preset: GenPreset) {
  if (recipeReaders.size) recipeReaders.forEach((read) => read(preset));
  else recipeWaiting = preset;
}

export function useRecipeInbox(read: ((preset: GenPreset) => void) | null) {
  useEffect(() => {
    if (!read) return;
    recipeReaders.add(read);
    const waiting = recipeWaiting;
    recipeWaiting = null;
    if (waiting) read(waiting);
    return () => { recipeReaders.delete(read); };
  }, [read]);
}
