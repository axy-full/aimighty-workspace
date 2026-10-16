"use client";
import { useState } from "react";
import { OverlayProvider, ToastProvider } from "../ui";
import { StepCard, type StepCardProps } from "../board/StepCard";
import "../v12.css";
import "./v25-parts.css";

/**
 * Test only (app/(test)/v25-board-parts, a 404 outside a local mock server): the v25 card, on a canvas like the board's, for the
 * screenshots beside design/particl-prototype-25 and tests/card-v25-workbench.spec.ts. EVERYTHING HERE IS MOCK DATA: the titles, the
 * statuses and the stand-in pictures stand for what the board screen will pass in when it is built; nothing is read from a workspace.
 */
const still = (hue: number) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},38%,26%)"/><stop offset="1" stop-color="hsl(${hue},30%,10%)"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/></svg>`)}`;

type Mock = Omit<StepCardProps, "onSelect" | "onApprove" | "onReject" | "onMenu">;
const SHOT_REASONS = ["Look", "Framing", "Motion", "Face", "Text"];

const SHOTS: Mock[] = [
  { id: "s1", title: "Shot 1 · Camp at night", status: "ready", version: 2, picture: { src: still(32) } },
  { id: "s2", title: "Shot 2 · MAYA arrives", status: "ready", picture: { src: still(210) }, video: true, poweredBy: "Runway", chips: [{ id: "len", label: "6 s" }] },
  { id: "s3", title: "Shot 3 · At the water", status: "none", picture: { src: still(200) } },
  { id: "s4", title: "Shot 4 · The drink", status: "ready", version: 3, picture: { src: still(28) }, video: true, chips: [{ id: "len", label: "8 s" }, { id: "refs", label: "2 refs" }] },
  { id: "s5", title: "Shot 5 · Bottle detail", status: "none", picture: { src: still(40) }, chips: [{ id: "len", label: "3 s" }] },
  { id: "s6", title: "Shot 6 · Pack on sand", status: "none", picture: { src: still(36) }, chips: [{ id: "len", label: "3 s" }] },
  { id: "s7", title: "Shot 7 · The sphere", status: "none", picture: { src: still(205) }, chips: [{ id: "len", label: "6 s" }] },
  { id: "s8", title: "Shot 8 · Last light", status: "none", picture: { src: still(30) }, chips: [{ id: "len", label: "4 s" }] },
];

const KINDS: Mock[] = [
  { id: "k-none", title: "Not started", status: "none", picture: { src: still(210) } },
  { id: "k-making", title: "Making", status: "making", progress: 60, picture: { src: still(32) } },
  { id: "k-ready", title: "Ready · one version", status: "ready", picture: { src: still(28) } },
  { id: "k-ready3", title: "Ready · three versions", status: "ready", version: 3, picture: { src: still(200) } },
  { id: "k-ok", title: "Approved", status: "approved", picture: { src: still(40) } },
  { id: "k-no", title: "Not right", status: "rejected", reason: "Look · warmer", picture: { src: still(0) } },
  { id: "k-text", title: "Director’s note", status: "ready", text: "A camp at the edge of a dry lake. One cold bottle, one warm light, and the people who have been walking since dawn.", tile: { letter: "M" } },
  { id: "k-tile", title: "Brand kit", status: "ready", own: "Brand kit · 3 files", tile: { letter: "M" } },
  { id: "k-sel", title: "Selected", status: "ready", picture: { src: still(210) }, selected: true },
  { id: "k-grey", title: "Greyed option", status: "ready", picture: { src: still(32) }, greyed: true },
  { id: "k-dim", title: "Dimmed", status: "ready", picture: { src: still(28) }, dimmed: true, chips: [{ id: "len", label: "6 s" }] },
  { id: "k-dim-text", title: "Dimmed page", status: "ready", text: "A camp at the edge of a dry lake. One cold bottle, one warm light.", tile: { letter: "M" }, dimmed: true },
  { id: "k-tgt", title: "Targeted", status: "ready", picture: { src: still(200) }, targeted: true },
  { id: "k-diff", title: "Differs from the step", status: "ready", picture: { src: still(36) }, differs: true, chips: [{ id: "look", label: "Firelight" }] },
];

function Board({ cards, label }: { cards: Mock[]; label: string }) {
  const [state, setState] = useState<Record<string, { status?: StepCardProps["status"]; reason?: string }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  return (
    <section className="v25-parts-canvas" aria-label={label} data-testid={`v25-board-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      <div className="v25-parts-grid">
        {cards.map((c) => {
          const now = state[c.id];
          return (
            <StepCard key={c.id} {...c} status={now?.status ?? c.status} reason={now?.reason ?? c.reason} reasons={SHOT_REASONS} draggable
              selected={c.selected || selected === c.id}
              onSelect={() => setSelected(c.id)} onOpen={() => setSaid(`Preview ${c.title}`)}
              onApprove={() => setState((s) => ({ ...s, [c.id]: { status: (s[c.id]?.status ?? c.status) === "approved" ? "ready" : "approved" } }))}
              onReject={(reason) => setState((s) => ({ ...s, [c.id]: { status: "rejected", reason } }))}
              onMenu={() => setSaid(`Menu ${c.title}`)} onChip={(id) => setSaid(`Chip ${id}`)} />
          );
        })}
      </div>
      <p className="v25-parts-said" data-testid="v25-said">{said}</p>
    </section>
  );
}

export function V25CardParts() {
  return (
    <OverlayProvider>
      <ToastProvider bottom={24}>
        <div className="v12 v25-parts">
          <h1 className="v25-parts-h">Card · Shots, as the board draws them (mock data)</h1>
          <Board cards={SHOTS} label="Shots" />
          <h1 className="v25-parts-h">Card · every status and kind (mock data)</h1>
          <Board cards={KINDS} label="Kinds" />
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}
