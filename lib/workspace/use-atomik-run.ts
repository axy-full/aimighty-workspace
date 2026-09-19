"use client";

/**
 * Thin React binding for the Atomik run engine. All run machinery lives on
 * the engine instance (created once per mount); React only
 * subscribes to its snapshots. Nothing here runs inside a state updater.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Plan, PlanContext } from "./plan-types";
import { AtomikRunEngine, type EngineState } from "./run-engine";

export type UseAtomikRun = {
  state: EngineState;
  engine: AtomikRunEngine;
  start: AtomikRunEngine["start"];
  pause: AtomikRunEngine["pause"];
  approve: AtomikRunEngine["approve"];
  decline: AtomikRunEngine["decline"];
  clearToast: AtomikRunEngine["clearToast"];
  clearNotice: AtomikRunEngine["clearNotice"];
};

export function useAtomikRun(
  plans: Partial<Record<string, Plan>>,
  context: PlanContext,
): UseAtomikRun {
  // One engine per mounted panel; its instance fields hold every loop and token.
  const [engine] = useState(
    () => new AtomikRunEngine({ plans, context: () => context }),
  );

  // The engine reads the context at every step, so an edit made while a run
  // waits at its gate is seen by approve() (and triggers a re-quote).
  useEffect(() => {
    engine.setContext(() => context);
  }, [engine, context]);

  const state = useSyncExternalStore(
    engine.subscribe,
    engine.getState,
    engine.getState,
  );

  return {
    state,
    engine,
    start: engine.start,
    pause: engine.pause,
    approve: engine.approve,
    decline: engine.decline,
    clearToast: engine.clearToast,
    clearNotice: engine.clearNotice,
  };
}
