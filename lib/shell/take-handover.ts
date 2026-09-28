"use client";
import { useEffect, useRef } from "react";

/**
 * "Open this take in Takes" while Takes is already on screen (the jobs tray's
 * Open in Takes). Takes picks the take it was sent (`selKind: take`) when it
 * opens; once it is open, a later selection is the Inspector's business, so a
 * take handed over from elsewhere comes through this letterbox instead. Only
 * a mounted Takes page reads it: nothing waits here for a page that is not
 * open, since that page reads the selection itself.
 */
const readers = new Set<(takeId: string) => void>();

export function handTakeToTakes(takeId: string) {
  readers.forEach((read) => read(takeId));
}

export function useHandedTake(read: (takeId: string) => void) {
  const latest = useRef(read);
  useEffect(() => { latest.current = read; }, [read]);
  useEffect(() => {
    const reader = (takeId: string) => latest.current(takeId);
    readers.add(reader);
    return () => { readers.delete(reader); };
  }, []);
}
