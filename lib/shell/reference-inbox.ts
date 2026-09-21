"use client";
import { useEffect } from "react";

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
