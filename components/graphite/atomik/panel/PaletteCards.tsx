"use client";
import { useEffect, type MutableRefObject } from "react";
import { useAtomikQuote } from "@/lib/useAtomikQuote";
import { askButton, thinkingLine, type AtomikIntent } from "@/lib/shell/atomik-panel";
import { usePriceTitle } from "../../Price";
import { usePlaces } from "./use-places";
import type { Project } from "@/lib/workbench/studio";

/**
 * ⌘K's Atomik cards for a question, a request or a memory line (Atomik frames c, and the master's "Ask Atomik: …"),
 * and for "make …". A question is answered free in Atomik's panel; a request is a planning turn in the open
 * project's Atomik thread, at the turn's own quote, which is the figure on the button (lead decision 29).
 */

type Enter = MutableRefObject<(() => void) | null>;

export function PaletteAskCard({ intent, project, onClose, enterRef }: {
  intent: Extract<AtomikIntent, { kind: "how" | "ask" | "memory" }>; project: Project | null; onClose: () => void; enterRef: Enter;
}) {
  const production = project?.productionProjectId ?? null;
  const places = usePlaces();
  /* The free quote of a new turn in this project's thread (the same route and body the panel's composer quotes). */
  const { quote, loading, error } = useAtomikQuote("/api/atomik", intent.kind === "ask" ? { text: intent.text, model: "auto", effort: "auto", projectId: production } : null);
  const credits = quote?.estimateCredits ?? null;
  const button = askButton(intent, { credits, loading, error });
  const title = usePriceTitle(button.price);
  const press = () => { onClose(); places.ask(intent.text, { send: true, approved: intent.kind === "ask" ? credits : null }); };
  /* Enter answers a free line; a priced one goes to the panel unsent, where its button is pressed. */
  useEffect(() => { enterRef.current = intent.kind === "ask" ? () => { onClose(); places.ask(intent.text); } : press; });
  return (
    <div className="ak-pcard" data-testid="palette-atomik-card" data-intent={intent.kind}>
      <span className="ak-eyebrow ak-accent">Atomik</span>
      <strong className="ak-pcard-title">Ask Atomik: {intent.text}</strong>
      <div className="ak-pcard-foot">
        <span className="ak-pcard-note" data-testid="palette-thinking-line">{button.reason ?? thinkingLine(intent, credits)}</span>
        <button type="button" className="ak-btn ak-btn-primary" disabled={button.disabled} title={title ?? (button.price?.kind === "free" ? "How-to answers are free" : undefined)}
          onClick={press} data-testid="palette-ask">{button.label}</button>
      </div>
    </div>
  );
}

/**
 * "make …" (Atomik frames c): Make opens with the words filled in, and Make shows its own engine line and price
 * before anything is made. No thinking is spent here, so the design's thinking line is left out (decision 29).
 */
export function PaletteMakeCard({ words, onOpen, enterRef }: { words: string; onOpen: () => void; enterRef: Enter }) {
  useEffect(() => { enterRef.current = onOpen; });
  return (
    <div className="ak-pcard" data-testid="palette-make-card">
      <span className="ak-eyebrow ak-accent">Atomik</span>
      <strong className="ak-pcard-title">Make “{words}”</strong>
      <p className="ak-pcard-line">Make opens with these words, its engine and its price. Nothing is made until you press Make.</p>
      <div className="ak-pcard-foot">
        <span className="ak-pcard-note">Free to open</span>
        <button type="button" className="ak-btn ak-btn-primary" onClick={onOpen} data-testid="palette-open-make">Open Make filled</button>
      </div>
    </div>
  );
}
