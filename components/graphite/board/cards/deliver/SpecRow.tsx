import type { SpecRow } from "./spec-check";
import "./deliver.css";

/** One delivery check: its label, its value, and its mark or the word that says why it has none. */
export function SpecRowView({ row }: { row: SpecRow }) {
  return (
    <div className="gx-deliver-row" data-mark={row.mark} data-testid={`deliver-${row.key}`}>
      <span className="gx-deliver-label">{row.label}</span>
      <span className="gx-deliver-value">
        {row.value}
        {row.mark === "ok" ? <span className="gx-deliver-ok" role="img" aria-label="checks out">✓</span> : null}
        {row.word ? <span className="gx-deliver-word" data-mark={row.mark}>{row.word}</span> : null}
      </span>
    </div>
  );
}

