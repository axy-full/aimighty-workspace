"use client";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { EMPTY_DRAFT, ASPECTS, LENGTHS, draftAspect, draftLength, withAspect, withLength, type HomeDraft } from "@/components/graphite/home/home-model";
import { decodeGuestBrief, guestBriefRaw, saveGuestBrief } from "@/lib/guest/brief";
import { wallLayout } from "@/lib/v12/home";
import { HOW_IT_WORKS, showcase, visitorBrief, type ShowcaseTile } from "@/lib/v12/visitor";
import { Bar, BarChip, BarSheet } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import { useOverlay } from "@/components/v12/ui";
import { useJoin } from "@/components/v12/join/JoinProvider";
import { FitText } from "@/components/v12/home/FitText";

/**
 * A visitor's Home (docs/redesign/inventory.md § 8.2): "Made with Particl", Particl's own public showcase on the wall;
 * "How it works"; and the bar. No Waiting for you, no Your boards: a visitor has no workspace. Tapping a tile picks it (the
 * rest fade, the bar opens its Length and Aspect), Start and "Make one like this" open the join sheet with the words
 * the visitor has, and the words are kept in this browser for after joining (lib/guest/brief.ts).
 */
export function VisitorHome({ compact }: { compact: boolean }) {
  const join = useJoin()!;
  const tiles = useState(showcase)[0];
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = tiles.find((t) => t.id === pickedId) ?? null;
  /* What this browser kept from an earlier visit, until the visitor edits the box. */
  const [draft, setDraft] = useState<HomeDraft>(() => decodeGuestBrief(guestBriefRaw()) ?? EMPTY_DRAFT);
  const edit = (next: HomeDraft) => { setDraft(next); saveGuestBrief(next); join.setPrompt(visitorBrief(picked, next.text)); };
  /* A picked tile is a selection on the overlay stack: Esc clears it after anything above it. */
  useOverlay("selection", Boolean(picked), () => setPickedId(null));

  const words = visitorBrief(picked, draft.text);
  const start = () => { join.setPrompt(words); join.openJoin("start", { prompt: words }); };
  /* Remix this: Make with the tile's own words, which a visitor cannot run. */
  const like = (tile: ShowcaseTile) => {
    const brief = visitorBrief(tile, draft.text);
    join.setPrompt(brief);
    join.openJoin("make", { prompt: brief });
  };

  /* The page leaves room under its last row for the bar as it is now. */
  const root = useRef<HTMLDivElement>(null);
  const barBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = root.current, bar = barBox.current;
    if (!host || !bar) return;
    const set = () => host.style.setProperty("--v12-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(set);
    seen.observe(bar);
    return () => seen.disconnect();
  }, []);

  const cells = wallLayout(tiles.length);
  const style = { "--v12-wall-row": compact ? "120px" : "118px" } as CSSProperties;
  return (
    <div className="v12-hm v12-vhome" data-testid="v12-visitor-home" data-screen-label="Home" ref={root} data-compact={compact ? "" : undefined}>
      <div className="v12-hm-scroll gx-scroll">
        <section aria-labelledby="v12-vhome-h" className="v12-vsection">
          <div className="v12-vhead">
            <h1 className="v12-vtitle" id="v12-vhome-h" data-testid="v12-visitor-title">Made with Particl</h1>
            <span className="v12-vsub">{compact ? "invite-only" : "Particl’s own showcase · tap a tile to make one like it"}</span>
          </div>
          <div className="v12-hm-wall" style={style} data-testid="v12-visitor-wall" data-picked={picked ? "" : undefined}>
            {tiles.map((tile, i) => {
              const on = picked?.id === tile.id;
              return (
                <div key={tile.id} className="v12-hm-tile" style={compact ? undefined : { gridColumn: cells[i].col, gridRow: cells[i].row }} data-picked={on ? "" : undefined}
                  data-faded={picked && !on ? "" : undefined} data-testid="v12-visitor-tile" data-tile={tile.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- Particl's own public still */}
                  <img className="v12-hm-tile-media" src={tile.url} alt="" loading="lazy" />
                  <button type="button" className="v12-hm-tile-pick" onClick={() => setPickedId((now) => (now === tile.id ? null : tile.id))} aria-pressed={on}
                    aria-label={`${on ? "Picked" : "Pick"}: ${tile.title}`} title={`${tile.title} · ${tile.type} — Make one like this`} data-testid="v12-visitor-tile-pick" />
                  <span className="v12-hm-tile-label" aria-hidden="true">
                    <FitText className="v12-hm-tile-type" text={tile.type} box=".v12-hm-tile" inset={40} />
                    <FitText className="v12-hm-tile-title" text={tile.title} box=".v12-hm-tile" inset={40} />
                  </span>
                  <span className="v12-hm-tile-hover">
                    <span className="v12-hm-tile-like" aria-hidden="true">Make one like this</span>
                    <button type="button" className="v12-hm-tile-remix" onClick={() => like(tile)} data-testid="v12-visitor-tile-remix">Remix this</button>
                  </span>
                  {on ? <span className="v12-hm-tile-picked" data-testid="v12-visitor-tile-picked">Picked</span> : null}
                </div>
              );
            })}
          </div>
        </section>
        <section aria-labelledby="v12-vhow-h" className="v12-vsection" data-testid="v12-visitor-how">
          <div className="v12-vhead">
            <h2 className="v12-vtitle v12-vtitle-sm" id="v12-vhow-h">How it works</h2>
            <span className="v12-vsub">Particl is invite-only</span>
          </div>
          <ol className="v12-vhow">
            {HOW_IT_WORKS.map((step, i) => (
              <li key={step.title} className="v12-vhow-card">
                {compact ? null : (
                  // eslint-disable-next-line @next/next/no-img-element -- Particl's own public still
                  <img className="v12-vhow-img" src={tiles[i % tiles.length].url} alt="" loading="lazy" />
                )}
                <span className="v12-vhow-head"><span className="v12-vhow-n" aria-hidden="true">{i + 1}</span><span className="v12-vhow-title">{step.title}</span></span>
                <span className="v12-vhow-line">{step.line}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <div className="v12-hm-bar" ref={barBox}>
        <Bar
          value={draft.text}
          onChange={(text) => edit({ ...draft, text })}
          onSubmit={start}
          placeholder={picked ? "Anything to add (optional)" : "Describe a film, ad or idea, or pick one above"}
          label={picked ? "Anything to add" : "Describe a film, ad or idea"}
          maxLength={900}
          onAttach={() => {}}
          onAttachPress={() => join.openJoin("upload", { prompt: words })}
          attachTitle="Attach a file — Needs a Particl account."
          sheet={picked ? (
            <BarSheet testId="v12-visitor-sheet" rows={[
              { label: "Length", options: LENGTHS, value: draftLength(draft), onPick: (v) => edit(withLength(draft, v)) },
              { label: "Aspect", options: ASPECTS, value: draftAspect(draft), onPick: (v) => edit(withAspect(draft, v)) },
            ]} />
          ) : null}
          chips={picked ? <BarChip tone="picked" thumb={picked.url} media="image" label={picked.type} onRemove={() => setPickedId(null)} testId="v12-visitor-picked-chip" /> : null}
          send={{ label: "Start", price: <Price quote={null} reason="visitorStart" testId="v12-visitor-start-price" />, testId: "v12-visitor-start" }}
          testId="v12-visitor-bar"
        />
      </div>
    </div>
  );
}
