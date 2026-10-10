"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { saveGuestBrief, decodeGuestBrief, guestBriefRaw } from "@/lib/guest/brief";
import { EMPTY_DRAFT, type HomeDraft } from "@/components/graphite/home/home-model";
import { showcase, visitorBrief, type ShowcaseTile } from "@/lib/v12/visitor";
import { Bar } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import { Segment } from "@/components/v12/ui";
import { useJoin } from "@/components/v12/join/JoinProvider";

/**
 * A visitor's Make (docs/redesign/inventory.md § 8.2, § 5.12): the composer and its modes work; the results are Particl's
 * own showcase, each marked "Sample"; pressing Make, Download, Send to board or Keep in Library opens the join sheet with
 * the words typed. A visitor has no session, so nothing is made, priced or kept here.
 */
const MODES = ["Auto", "Image", "Video", "Audio", "Remix", "Edit"] as const;
type Mode = (typeof MODES)[number];
/* The composer's words by mode (prototype L176–L190). */
const PLACEHOLDER: Record<Mode, string> = {
  Auto: "Describe anything · Atomik picks the model and settings",
  Image: "Describe a still",
  Video: "Describe a clip",
  Audio: "A line, a cue or a sound",
  Remix: "Paste a video link, or drop a file here",
  Edit: "What to change in the last result (optional)",
};

export function VisitorMake({ compact }: { compact: boolean }) {
  const join = useJoin()!;
  const tiles = useState(showcase)[0];
  const [mode, setMode] = useState<Mode>("Image");
  const [draft, setDraft] = useState<HomeDraft>(() => decodeGuestBrief(guestBriefRaw()) ?? EMPTY_DRAFT);
  const edit = (text: string) => { const next = { ...draft, text }; setDraft(next); saveGuestBrief(next); join.setPrompt(text); };
  const make = () => { join.setPrompt(draft.text); join.openJoin("make", { prompt: draft.text }); };
  const act = (tile: ShowcaseTile, reason: "download" | "plus" | "library") => { const words = visitorBrief(tile, draft.text); join.setPrompt(words); join.openJoin(reason, { prompt: words }); };

  const root = useRef<HTMLDivElement>(null);
  const bandBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = root.current, band = bandBox.current;
    if (!host || !band) return;
    const set = () => host.style.setProperty("--v12-bar-h", `${Math.ceil(band.getBoundingClientRect().height)}px`);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(set);
    seen.observe(band);
    return () => seen.disconnect();
  }, []);

  return (
    <div className="v12-hm v12-vmake" data-testid="v12-visitor-make" ref={root} data-compact={compact ? "" : undefined}>
      <div className="v12-hm-scroll gx-scroll">
        <div className="v12-vhead">
          <h1 className="v12-vtitle v12-vtitle-sm">Results</h1>
          <span className="v12-vsub">newest first</span>
          <span className="v12-grow" />
          <span className="v12-vsub v12-vmono">{tiles.length} results</span>
        </div>
        <div className="v12-vmake-grid" data-testid="v12-visitor-results">
          {tiles.map((tile) => (
            <figure key={tile.id} className="v12-vmake-tile" data-testid="v12-visitor-result">
              {/* eslint-disable-next-line @next/next/no-img-element -- Particl's own public still */}
              <img src={tile.url} alt={tile.title} loading="lazy" />
              <span className="v12-vmake-sample" data-testid="v12-visitor-sample-pill">Sample</span>
              <span className="v12-vmake-acts">
                <button type="button" className="v12-vbtn" onClick={() => act(tile, "download")} data-testid="v12-visitor-download">Download</button>
                <button type="button" className="v12-vbtn" onClick={() => act(tile, "plus")} data-testid="v12-visitor-send">Send to board</button>
                <button type="button" className="v12-vbtn" onClick={() => act(tile, "library")} data-testid="v12-visitor-keep">Keep in Library</button>
              </span>
            </figure>
          ))}
        </div>
      </div>
      <div className="v12-vmake-band" ref={bandBox}>
        <div className="v12-vmake-modes"><Segment<Mode> label="Mode" options={MODES.map((m) => ({ id: m, label: m }))} value={mode} onChange={setMode} /></div>
        <Bar value={draft.text} onChange={edit} onSubmit={make} placeholder={PLACEHOLDER[mode]} label="What to make" maxLength={900}
          onAttach={() => {}} onAttachPress={() => join.openJoin("upload", { prompt: draft.text })} attachTitle="Attach a file — Needs a Particl account."
          send={{ label: "Make", price: <Price quote={null} reason="visitorMake" testId="v12-visitor-make-price" />, testId: "v12-visitor-make-send" }} testId="v12-visitor-make-bar" />
      </div>
    </div>
  );
}
