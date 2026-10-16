"use client";
import { useMemo, useState } from "react";
import { OverlayProvider, ToastProvider } from "../ui";
import { StepCard, type StepCardProps } from "../board/StepCard";
import { ShotStepCard } from "../board/ShotStepCard";
import { ShotPreview } from "../board/ShotPreview";
import { CardPreview } from "../board/CardPreview";
import type { PreviewItemView } from "../board/preview-model";
import { SHOT_REASONS as TAKE_REASONS } from "../board/shot-card";
import type { ShotTakes, ShotVersion } from "@/components/graphite/board/cards/take/take-model";
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
  { id: "k-pic-tile", title: "Picture with a brand tile", status: "ready", picture: { src: still(32) }, tile: { letter: "M" } },
  { id: "k-grey-text", title: "Greyed page", status: "ready", text: "A camp at the edge of a dry lake. One cold bottle, one warm light.", tile: { letter: "M" }, greyed: true },
  { id: "k-sel", title: "Selected", status: "ready", picture: { src: still(210) }, selected: true },
  { id: "k-grey", title: "Greyed option", status: "ready", picture: { src: still(32) }, greyed: true },
  { id: "k-dim", title: "Dimmed", status: "ready", picture: { src: still(28) }, dimmed: true, chips: [{ id: "len", label: "6 s" }] },
  { id: "k-dim-text", title: "Dimmed page", status: "ready", text: "A camp at the edge of a dry lake. One cold bottle, one warm light.", tile: { letter: "M" }, dimmed: true },
  { id: "k-tgt", title: "Targeted", status: "ready", picture: { src: still(200) }, targeted: true },
  { id: "k-diff", title: "Differs from the step", status: "ready", picture: { src: still(36) }, differs: true, chips: [{ id: "look", label: "Firelight" }] },
];

/* Shots from takes (PR 5): the card fed by a shot's takes, ✓ and ✕ going through the review trail's own routes (the browser check answers them). Mock rows. */
const version = (genId: string, n: number, status: ShotVersion["status"], over: Partial<ShotVersion> = {}): ShotVersion => ({
  id: `generation:${genId}`, genId, version: n, label: `v${n}`, status, stage: null, media: "image", url: still(30 + n * 40), createdAt: n, engine: "Nano Banana Pro · 1K", prompt: "A camp at night",
  task: "generate", reason: null, charge: null, nothingBilled: false, retry: false, needs: null, approvedBy: null, approvedAt: null, reviewBy: null, updatedAt: n, references: [], entry: {} as never, ...over,
});
const shot = (index: number, title: string, versions: ShotVersion[], shown: ShotVersion | null = versions[versions.length - 1] ?? null): ShotTakes => ({
  nodeId: `shot-${index}`, index, productionShotId: `ps-${index}`, title: `Shot ${index} · ${title}`, name: title, line: "", versions, shown, frame: null, typicalMs: null, anchor: null,
});
const ROWS: ShotTakes[] = [
  shot(1, "Camp at night", [version("gen_s1a", 1, "changes"), version("gen_s1b", 2, "review")]),
  shot(2, "MAYA arrives", [version("gen_s2", 1, "review")]),
  shot(3, "At the water", [version("gen_s3", 1, "approved", { approvedBy: "Reviewer One" })]),
  shot(4, "The drink", [version("gen_s4", 1, "rendering", { url: null })]),
  shot(5, "Bottle detail", [version("gen_s5", 1, "failed", { url: null })]),
  shot(6, "Pack on sand", []),
  shot(7, "Three versions", [version("gen_s7a", 1, "changes"), version("gen_s7b", 2, "review"), version("gen_s7c", 3, "review")]),
  { ...shot(8, "A clip", [version("gen_s8", 1, "review", { media: "video", url: "/fixtures/clip.mp4" })]), frame: { url: still(210), kind: "image" } },
];

/* Cards that are not takes: a script (Script · Beats · Breakdown) and a sound, as preview items (mock). */
const SCRIPT: PreviewItemView = {
  id: "script", title: "Script", kind: "text", shown: 0, canJudge: false, reasons: TAKE_REASONS,
  versions: [{ label: "v1", url: null, poster: null, status: "ready" }],
  tabs: [
    { id: "script", label: "Script", text: "INT. CAMP — NIGHT\nA cold bottle on a warm table." },
    { id: "beats", label: "Beats", text: "1. The arrival\n2. The water\n3. The first sip" },
    { id: "breakdown", label: "Breakdown", text: "Shot 1 camp · Shot 2 arrival · Shot 3 water" },
  ],
};
const SOUND: PreviewItemView = {
  id: "sound", title: "Voice · line 1", kind: "sound", shown: 0, canJudge: false, reasons: TAKE_REASONS,
  versions: [{ genId: "gen_voice", label: "v1", url: "/fixtures/tone.mp3", poster: null, status: "ready" }],
};

function TakeBoard() {
  const [open, setOpen] = useState<string | null>(null);
  const [demo, setDemo] = useState<"script" | "sound" | null>(null);
  const demos = useMemo(() => new Map([[SCRIPT.id, SCRIPT], [SOUND.id, SOUND]]), []);
  return (
    <section className="v25-parts-canvas" aria-label="Takes" data-testid="v25-board-takes">
      <div className="v25-parts-grid">
        {ROWS.map((row) => <ShotStepCard key={row.nodeId} row={row} scope="particl-active-test" projectId="test-project" onOpen={() => setOpen(row.nodeId)} />)}
      </div>
      <p className="v25-parts-said">
        <button type="button" className="v25-parts-btn" data-testid="open-script" onClick={() => setDemo("script")}>Preview a script</button>{" "}
        <button type="button" className="v25-parts-btn" data-testid="open-sound" onClick={() => setDemo("sound")}>Preview a sound</button>
      </p>
      {open ? <ShotPreview rows={ROWS} scope="particl-active-test" projectId="test-project" openId={open} onStep={setOpen} onClose={() => setOpen(null)} placement="fixed" note="The column and the bar act on this shot." /> : null}
      {demo ? <CardPreview items={demos} ids={[demo]} openId={demo} onStep={() => {}} onClose={() => setDemo(null)} placement="fixed" /> : null}
    </section>
  );
}

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
          <h1 className="v25-parts-h">Card · fed by a shot’s takes (mock rows; ✓ ✕ call the review routes)</h1>
          <TakeBoard />
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}
