"use client";
import { EarlierScripts } from "../../EarlierScripts";
import type { DocData } from "../plan/derive";
import type { CardProps } from "../types";

/**
 * The Inspector of a document card. The project's brief card also holds the script's state and its Earlier scripts (owner decision 11), the one place the board
 * keeps them after the Undo on "Use as script" has gone; a brief placed on the canvas says what it says.
 */
export function DocInspector({ data, ctx }: CardProps<DocData>) {
  if (data.variant === "node") {
    return (
      <div className="gx-insp-take" data-testid="insp-doc">
        <div className="gx-insp-title">{data.title}</div>
        {data.text.trim() ? <p className="gx-insp-prompt">{data.text}</p> : null}
      </div>
    );
  }
  const script = (ctx.project.script ?? "").trim();
  return (
    <div className="gx-insp-take" data-testid="insp-brief">
      <div className="gx-insp-title">{data.doc.title}</div>
      <div className="gx-insp-meta" data-testid="insp-script-state">{script ? `Script · ${script.length.toLocaleString("en-US")} characters` : "No script yet"}</div>
      <EarlierScripts ctx={ctx} />
    </div>
  );
}
