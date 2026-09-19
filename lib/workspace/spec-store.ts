"use client";
import { useSyncExternalStore } from "react";
import type { SpecFacts } from "./spec-cards";
import type { PageId } from "./types";

/**
 * The facts a mounted spec page counted from its data (project draft,
 * pipeline runs, budget), shared with the Inspector, which the shell renders
 * as its sibling. The Inspector's SPECIFICATION table reads the same object
 * the cards do, so the two never disagree.
 */

type Published = { page: PageId; facts: SpecFacts } | null;

let published: Published = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

export function publishSpecFacts(page: PageId, facts: SpecFacts) {
  published = { page, facts };
  emit();
}

export function clearSpecFacts(page: PageId) {
  if (published?.page !== page) return;
  published = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => published;
const serverSnapshot = (): Published => null;

/** The facts the page body published for `page`, or null before it has. */
export function useSpecFacts(page: PageId): SpecFacts | null {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return value?.page === page ? value.facts : null;
}
