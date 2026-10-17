"use client";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { IconButton, MoreDots } from "../ui";
import { canJudge, rejectReason, statusLine, withOther, type CardStatus } from "./card-model";
import "./card.css";
import TieredImg from "@/components/TieredImg";

/** A chip on a card: only where the card differs from its step's setting (v24 change 5). */
export type CardChip = { id: string; label: string };

/** The brand tile: the client's letter, or the brand-kit logo when there is one. */
export type CardTile = { letter: string; src?: string };

export type StepCardProps = {
  id: string;
  title: string;
  status: CardStatus;
  /** Shown as "Ready · v3" when more than one. */
  version?: number;
  /** What ✕ was given: "✕ <reason>". */
  reason?: string;
  /** 0 to 100, the bar on the picture while Making…. */
  progress?: number;
  /** An item the person owns: it says what it is in the status line and has no ✓ / ✕. */
  own?: string;
  /** A picture at its ratio ("16 / 9", "9 / 16", "1 / 1"), cropped to fill. */
  picture?: { src: string; ratio?: string; position?: string } | null;
  /** A text-only page: drawn as a small page, a title row (tile and title) then its first lines. */
  text?: string;
  /** The tile: large and centred on a card with neither picture nor text, small in the corner of a picture. */
  tile?: CardTile;
  video?: boolean;
  /** "Runway": the one place a model's name may show (v25 rules), as "Powered by …". */
  poweredBy?: string;
  selected?: boolean;
  /** Lit by hovering the button that would act on it. */
  targeted?: boolean;
  /** Differs from its step's setting. */
  differs?: boolean;
  /** Dimmed while another card is the focus. */
  dimmed?: boolean;
  /** An option step's other options, after one is picked. */
  greyed?: boolean;
  chips?: readonly CardChip[];
  /** ✕'s reasons for this step; "Other" is always added at the end. */
  reasons?: readonly string[];
  /** Shows the drag handle on hover and makes the card draggable. */
  draggable?: boolean;
  onSelect?: (event: MouseEvent<HTMLElement>) => void;
  /** Double-click, Enter or Space: the preview. */
  onOpen?: () => void;
  /** ✓ toggles: Approved, or back to Ready. */
  onApprove?: () => void;
  onReject?: (reason: string) => void;
  /** ⋯ and right-click. */
  onMenu?: (anchor: HTMLElement, at: { x: number; y: number }) => void;
  onChip?: (id: string) => void;
  onDragStart?: (event: React.DragEvent<HTMLElement>) => void;
};

/** A picture of the board's own (a take, a brand-kit logo): in width tiers at the size it is drawn when it is a Particl still (components/TieredImg.tsx). */
function Img({ src, className, style, draggable }: { src: string; className?: string; style?: CSSProperties; draggable?: boolean }) {
  return <TieredImg src={src} alt="" loading="lazy" className={className} style={style} draggable={draggable} />;
}

const letterTile = (tile: CardTile, className: string) => (
  <span className={className} aria-hidden="true">
    {tile.src ? <Img src={tile.src} /> : tile.letter}
  </span>
);

/**
 * The v25 card (design/particl-prototype-25 "Particl board.dc.html", README "CARD SYSTEM"): picture (or tile, or a page of text), a title and
 * one status line. Five statuses: Not started · Making… (a bar on the picture) · Ready (· vN) · ✓ Approved · ✕ <reason>. On hover or focus a
 * card that is ready to judge shows ✓ and ✕ with ⋯, in the title row on text cards, never over the text; ✕ opens the step's reason chips
 * (always ending "Other") and one optional line, Enter sends. Chips show only where the card differs from the step. Rules in card-model.ts.
 *
 * Drawn by the board screen when it is built; today only the test page (app/(test)/v25-board-parts) draws it.
 */
export function StepCard(props: StepCardProps) {
  const { id, title, status, picture, text, tile, selected, targeted, differs, dimmed, greyed, chips = [], onMenu } = props;
  const line = statusLine({ status, version: props.version, reason: props.reason, own: props.own });
  const judge = canJudge({ status, userOwned: props.own !== undefined, greyed });
  const [reasoning, setReasoning] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isText = !picture && text !== undefined;
  const bigTile = !picture && !isText && Boolean(tile);
  const notStarted = status === "none" && props.own === undefined;

  const closeReasons = () => { setReasoning(false); setPick(null); setNote(""); };
  const send = (chosen: string | null, line: string) => { props.onReject?.(rejectReason(chosen, line)); closeReasons(); };
  const openMenu = (anchor: HTMLElement, event?: { clientX: number; clientY: number }) => {
    const box = anchor.getBoundingClientRect();
    onMenu?.(anchor, event ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    /* Esc closes ✕'s reasons from anywhere in the card, and keeps the status. */
    if (event.key === "Escape" && reasoning) { event.stopPropagation(); closeReasons(); root.current?.focus(); return; }
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onOpen?.(); }
  };

  return (
    <div ref={root} className="v12-card" role="group" tabIndex={0} aria-label={`${title}. ${line.text}`}
      data-testid="v12-card" data-card={id} data-status={status} data-selected={selected ? "" : undefined} data-targeted={targeted ? "" : undefined}
      data-differs={differs ? "" : undefined} data-dimmed={dimmed ? "" : undefined} data-greyed={greyed ? "" : undefined} data-none={notStarted ? "" : undefined}
      data-kind={picture ? "picture" : isText ? "text" : "tile"} data-judge={judge ? "" : undefined} draggable={props.draggable || undefined}
      onClick={props.onSelect} onDoubleClick={props.onOpen} onKeyDown={onKey} onDragStart={props.onDragStart}
      onContextMenu={onMenu ? (event) => { event.preventDefault(); openMenu(event.currentTarget, event); } : undefined}>
      <div className="v12-card-media" style={{ aspectRatio: picture?.ratio ?? "16 / 9" }}>
        {bigTile && tile ? letterTile(tile, "v12-card-tile v12-card-tile-lg") : null}
        {picture ? <Img className="v12-card-img" src={picture.src} draggable={false} style={{ objectPosition: picture.position ?? "50% 50%" }} /> : null}
        {picture && tile ? letterTile(tile, "v12-card-tile v12-card-tile-sm") : null}
        {isText ? (
          <div className="v12-card-page">
            <div className="v12-card-page-head">
              {tile ? letterTile(tile, "v12-card-tile v12-card-tile-xs") : null}
              <span className="v12-card-page-title">{title}</span>
            </div>
            <div className="v12-card-page-text">{text}</div>
          </div>
        ) : null}
        {props.video ? <span className="v12-card-play" aria-hidden="true">▶</span> : null}
        {status === "making" && props.own === undefined ? (
          <span className="v12-card-bar" role="progressbar" aria-label={`${title}: making`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(props.progress ?? 0)}>
            <span style={{ width: `${Math.max(0, Math.min(100, props.progress ?? 0))}%` }} />
          </span>
        ) : null}
        {props.poweredBy ? <span className="v12-card-by">Powered by {props.poweredBy}</span> : null}
        {props.draggable ? <span className="v12-card-handle" aria-hidden="true" data-text={isText ? "" : undefined}>⠿</span> : null}
        <span className="v12-card-marks" data-text={isText ? "" : undefined}>
          {judge ? (
            <>
              <IconButton className="v12-card-mark" data-mark="ok" size="sm" label={`Approve ${title}`} pressed={status === "approved"}
                tooltip={{ name: status === "approved" ? "Approved" : "Approve", line: status === "approved" ? "Press again to undo." : undefined }}
                onClick={(event) => { event.stopPropagation(); props.onApprove?.(); }}>✓</IconButton>
              <IconButton className="v12-card-mark" data-mark="no" size="sm" label={`Not right: ${title}`} pressed={reasoning}
                tooltip={{ name: "Not right", line: "Say why." }}
                /* Not stopped: v25 selects the card it is on, so the column and the bar say what ✕ is about. */
                onClick={() => { if (reasoning) closeReasons(); else setReasoning(true); }}>✕</IconButton>
            </>
          ) : null}
          {onMenu ? (
            <IconButton className="v12-card-mark" data-mark="more" size="sm" label={`More for ${title}`} tooltip={{ name: "More" }} aria-haspopup="menu"
              onClick={(event) => { event.stopPropagation(); openMenu(event.currentTarget); }}><MoreDots size={14} /></IconButton>
          ) : null}
        </span>
        {greyed ? <span className="v12-card-grey" aria-hidden="true" /> : null}
      </div>
      <div className="v12-card-body">
        <div className="v12-card-titlerow">
          {differs ? <span className="v12-card-diff" aria-hidden="true" /> : null}
          <span className="v12-card-title">{title}</span>
        </div>
        <span className="v12-card-status" data-tone={line.tone} data-testid="v12-card-status">
          <span className="v12-card-dot" data-tone={line.dot} aria-hidden="true" />
          {line.text}
        </span>
        {reasoning ? (
          <div className="v12-card-reasons" data-testid="v12-card-reasons" onClick={(event) => event.stopPropagation()}>
            <span className="v12-card-reasons-label">What’s wrong?</span>
            <div className="v12-card-reasons-list" role="group" aria-label="What’s wrong?">
              {withOther(props.reasons ?? []).map((reason) => (
                <button key={reason} type="button" className="v12-card-reason" aria-pressed={pick === reason} data-on={pick === reason ? "" : undefined}
                  onClick={() => { if (reason === "Other") { setPick(reason); input.current?.focus(); } else send(reason, note); }}>{reason}</button>
              ))}
            </div>
            <input ref={input} className="v12-card-note" value={note} aria-label="One line, optional" placeholder="One line, optional · ⏎ to send" autoFocus={false}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); send(pick, note); } }} />
          </div>
        ) : null}
        {chips.length ? (
          <div className="v12-card-chips">
            {chips.map((chip) => (
              <button key={chip.id} type="button" className="v12-card-chip" data-chip={chip.id} title="Change it here"
                onClick={(event) => { event.stopPropagation(); props.onChip?.(chip.id); }}>{chip.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
