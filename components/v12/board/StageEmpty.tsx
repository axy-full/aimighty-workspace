"use client";
import type { StageEmpty as Empty } from "@/lib/v12/board/stages";

/** A stage with nothing on it (prototype L616): its title and line, and for a stage a person added, Ask Atomik. */
export function StageEmpty({ empty, onAsk }: { empty: Empty; onAsk?: () => void }) {
  return (
    <div className="v12-stage-empty" data-testid="v12-stage-empty">
      <h2 className="v12-stage-empty-title">{empty.title}</h2>
      <p className="v12-stage-empty-line">{empty.line}</p>
      {empty.ask && onAsk ? <button type="button" className="v12-btn" onClick={onAsk}>Ask Atomik</button> : null}
    </div>
  );
}
