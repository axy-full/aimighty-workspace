"use client";
import { useState } from "react";
import { CHANGED_WORDS, changedLine } from "@/lib/workbench/changed-since";

/**
 * "Changed since you opened it" (prototype v15 item 6): a slim bar under the stage header. Someone saved this board while this window held an unsaved change to
 * the same thing; nothing is sent until the person chooses. Reload is the screen's one filled button (the stage's next action drops to an outline while this
 * shows); Keep my version is quiet.
 */
export function ChangedBar({ changed, onReload, onKeep }: {
  changed: { by: string | null; at: number; things: readonly string[] };
  onReload: () => void;
  onKeep: () => void;
}) {
  const [now] = useState(() => Date.now());
  return (
    <div className="v12-changedbar" role="status" data-testid="v12-changed-bar">
      <span className="v12-changedbar-line">{changedLine(changed, Math.max(now, changed.at))}</span>
      <span className="v12-changedbar-actions">
        <button type="button" className="v12-primary" onClick={onReload} data-testid="v12-changed-reload">{CHANGED_WORDS.reload}</button>
        <button type="button" className="v12-changedbar-keep" onClick={onKeep} data-testid="v12-changed-keep">{CHANGED_WORDS.keep}</button>
      </span>
    </div>
  );
}
