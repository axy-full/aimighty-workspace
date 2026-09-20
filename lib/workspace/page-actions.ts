"use client";
import { useEffect, useRef } from "react";
import type { PageId } from "./types";

/**
 * The page header's primary button belongs to the shell, but on Takes and
 * Cast the work it starts belongs to the page body (its file picker, its
 * identity panel). A page registers a handler for its own id; the header
 * calls it synchronously inside the click, so a file picker still opens
 * with the user's gesture. With no handler registered the header falls back
 * to the existing workbench flow.
 */
const handlers = new Map<PageId, () => void>();

export function runPageAction(page: PageId): boolean {
  const handler = handlers.get(page);
  if (!handler) return false;
  handler();
  return true;
}

export function hasPageAction(page: PageId) {
  return handlers.has(page);
}

export function usePageAction(page: PageId, handler: () => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const run = () => ref.current();
    handlers.set(page, run);
    return () => {
      if (handlers.get(page) === run) handlers.delete(page);
    };
  }, [page]);
}
