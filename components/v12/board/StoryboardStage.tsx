"use client";
import { useState, type CSSProperties } from "react";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { useFramePoller, useStoryboardDraw } from "@/components/graphite/board/cards/storyboard/use-frames";
import { usePriceTitle } from "@/components/graphite/Price";
import { Dialog, Segment } from "@/components/v12/ui";
import { priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { FRAME_REASONS, SHEET_SIZES, DEFAULT_SHEET_SIZE, STYLES, frameCards, redoShots, sheetPages, storyboardLine, styleOf, takesOf, withFramePrompt, withPick, withStyle, type FrameCardModel, type SheetSize } from "@/lib/v12/board/storyboard-step";
import { withMark, withoutMark } from "@/lib/v12/board/text-steps";
import { useScreenScale } from "./use-screen-scale";
import { StepCard } from "./StepCard";
import "./stage-pages.css";
import "./card-scale.css";
import "./storyboard-stage.css";

/**
 * Storyboard, the Film board's drawing step (design/particl-prototype-25 step "storyboard"; demo plan PR 18): one v25 card per shot, drawn in
 * the board's style, a board sheet of them in pages, ✓ and ✕ on each frame. Every frame is drawn on the path that has always drawn them
 * (components/graphite/board/cards/storyboard/use-frames.ts): each priced by the server, sent by one person's press at the figure on the
 * button, stopping at the first refusal or price that moved. A frame marked ✕ is drawn again by the same press, as a new take. Nothing else
 * here spends; Atomik can be asked for any of it from the same screen.
 */
const clock = () => Date.now();
const ratioOf = (aspect: string) => aspect.replace(":", " / ");

export function StoryboardStage({ ctx }: { ctx: BoardCtx }) {
  const project = ctx.project;
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const canEdit = !blocked;
  const scale = useScreenScale(true);
  const seam = { scope: ctx.scope, project, apply: ctx.rig.apply, save: ctx.rig.save };
  useFramePoller(seam);
  const cards = frameCards(project);
  const redo = redoShots(project);
  const draw = useStoryboardDraw(seam, blocked, redo);
  const title = usePriceTitle(ctx.exploreOnly ? null : draw.price);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const words = draw.price && !ctx.exploreOnly ? priceWords(draw.price) : null;
  const undrawn = cards.filter((c) => !c.genId && c.status !== "making").length;
  const verb = undrawn ? `Draw ${draw.count} ${draw.count === 1 ? "frame" : "frames"}` : `Draw ${draw.count} again`;

  const write = (change: (p: typeof project) => typeof project) => {
    const refused = ctx.rig.apply(change);
    if (refused) ctx.toast(refused);
  };
  const toggleApprove = (c: FrameCardModel) => {
    if (!c.genId) return;
    if (c.status === "approved") write((p) => ({ ...p, boardMarks: withoutMark(p.boardMarks, c.shotId) }));
    else write((p) => ({ ...p, boardMarks: withMark(p.boardMarks, c.shotId, c.genId!, "approved", clock()) }));
  };
  const reject = (c: FrameCardModel, reason: string) => {
    if (c.genId) write((p) => ({ ...p, boardMarks: withMark(p.boardMarks, c.shotId, c.genId!, "rejected", clock(), reason) }));
  };

  return (
    <div className="v12-sp v12-sb" data-testid="v12-storyboard-stage">
      <div className="v12-sb-bar">
        <Segment<string> label="Drawing style" value={styleOf(project)} onChange={(style) => write((p) => withStyle(p, style as ReturnType<typeof styleOf>))}
          options={STYLES.map((s) => ({ id: s.id, label: s.label, tooltip: { name: s.label, line: s.line }, disabled: !canEdit }))} />
        <span className="v12-sp-why" data-testid="v12-storyboard-line">{storyboardLine(project)}</span>
        <span className="v12-sb-grow" />
        <button type="button" className="v12-sp-btn" onClick={() => setSheet(true)} disabled={!cards.length} data-testid="v12-storyboard-sheet">Board sheet</button>
        <button type="button" className="v12-sp-btn" onClick={() => ctx.askAtomik("Draw the storyboard for this film: ")} data-testid="v12-storyboard-ask">Ask Atomik</button>
        {draw.pricing === "error" && !ctx.exploreOnly ? (
          <button type="button" className="v12-sp-btn" onClick={draw.tryAgain} data-testid="v12-storyboard-try-again">Try again</button>
        ) : draw.count ? (
          <button type="button" className="v12-sp-btn v12-sp-primary" title={title ?? undefined} disabled={Boolean(blocked) || !words || draw.busy} aria-busy={draw.busy || undefined}
            onClick={() => { void draw.draw(); }} data-testid="v12-storyboard-draw" {...spendAttrsOf(ctx.exploreOnly ? null : draw.price)}>
            {draw.busy ? "Sending frames…" : words ? `${verb} · ${words}` : verb}
          </button>
        ) : null}
      </div>
      {draw.problem ? <p className="v12-sp-why v12-sp-problem" role="alert" data-testid="v12-storyboard-problem">{draw.problem}</p> : null}
      {draw.pricing === "error" && !ctx.exploreOnly ? <p className="v12-sp-why" role="status">The price could not be read.</p> : null}
      {cards.length ? (
        <div className="v12-sb-grid v12-scaled" style={{ "--k": scale } as CSSProperties}>
          {cards.map((c) => (
            <StepCard key={c.shotId} id={`frame-${c.shotId}`} title={c.name} status={c.status} version={c.version} reason={c.reason}
              picture={c.genId ? { src: `/api/media/${c.genId}`, ratio: ratioOf(project.aspect || "16:9") } : null}
              tile={{ letter: String(c.index) }} reasons={FRAME_REASONS}
              onSelect={(event) => { if (!(event.target as HTMLElement).closest(".v12-card-marks, .v12-card-reasons")) setOpen(c.shotId); }} onOpen={() => setOpen(c.shotId)}
              onApprove={canEdit ? () => toggleApprove(c) : undefined} onReject={canEdit ? (reason) => reject(c, reason) : undefined} />
          ))}
        </div>
      ) : (
        <p className="v12-sp-why" data-testid="v12-storyboard-none">No shots yet. The storyboard has one frame for each shot of the script: write the script, then break it down into shots.</p>
      )}
      {open ? <FrameDialog ctx={ctx} card={cards.find((c) => c.shotId === open)} canEdit={canEdit} onClose={() => setOpen(null)} write={write} /> : null}
      {sheet ? <SheetDialog cards={cards} aspect={project.aspect || "16:9"} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}

function FrameDialog({ ctx, card, canEdit, onClose, write }: { ctx: BoardCtx; card: FrameCardModel | undefined; canEdit: boolean; onClose: () => void; write: (change: (p: BoardCtx["project"]) => BoardCtx["project"]) => void }) {
  const [text, setText] = useState(card?.prompt ?? "");
  if (!card) return null;
  const takes = takesOf(ctx.project, card.shotId);
  return (
    <Dialog open onClose={onClose} label={card.name} title={card.name} width={720} testId="v12-frame-preview">
      <div className="v12-sb-pane">
        {card.genId ? (
          // eslint-disable-next-line @next/next/no-img-element -- the board's own take, served by its own route
          <img className="v12-sb-big" src={`/api/media/${card.genId}`} alt={card.name} style={{ aspectRatio: ratioOf(ctx.project.aspect || "16:9") }} />
        ) : <p className="v12-sp-why">Not drawn yet. Draw the storyboard to make this frame.</p>}
        <p className="v12-sp-why">{card.line}</p>
        {takes.length > 1 ? (
          <div className="v12-sb-takes" role="group" aria-label="Versions">
            {takes.map((id, i) => (
              <button key={id} type="button" className="v12-sb-take" aria-pressed={id === card.genId} disabled={!canEdit} onClick={() => write((p) => withPick(p, card.shotId, id))} data-testid="v12-frame-take">
                {/* eslint-disable-next-line @next/next/no-img-element -- the board's own take */}
                <img src={`/api/media/${id}`} alt={`Version ${takes.length - i}`} />
              </button>
            ))}
          </div>
        ) : null}
        <label className="v12-ts-field"><span className="v12-sp-eyebrow">Drawn from</span>
          <textarea className="v12-ts-text" rows={4} value={text} placeholder="Starts from the shot's own words." readOnly={!canEdit}
            onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== card.prompt) write((p) => withFramePrompt(p, card.shotId, text)); }} data-testid="v12-frame-words" />
        </label>
      </div>
    </Dialog>
  );
}

/** The board sheet: the frames in pages of four, six or nine, each with its shot's name and line. Free. */
function SheetDialog({ cards, aspect, onClose }: { cards: FrameCardModel[]; aspect: string; onClose: () => void }) {
  const [size, setSize] = useState<SheetSize>(DEFAULT_SHEET_SIZE);
  const pages = sheetPages(cards, size);
  return (
    <Dialog open onClose={onClose} label="Board sheet" title="Board sheet" width={960} testId="v12-board-sheet">
      <div className="v12-sb-pane">
        <Segment<string> label="Frames to a page" value={String(size)} onChange={(v) => setSize(Number(v) as SheetSize)} options={SHEET_SIZES.map((n) => ({ id: String(n), label: `${n} a page` }))} />
        {pages.map((page, i) => (
          <section key={i} className="v12-sb-page" data-size={size} aria-label={`Page ${i + 1} of ${pages.length}`} data-testid="v12-sheet-page">
            {page.map((c) => (
              <figure key={c.shotId} className="v12-sb-cell">
                {c.genId
                  // eslint-disable-next-line @next/next/no-img-element -- the board's own take
                  ? <img src={`/api/media/${c.genId}`} alt={c.name} style={{ aspectRatio: ratioOf(aspect) }} />
                  : <span className="v12-sb-empty" style={{ aspectRatio: ratioOf(aspect) }}>Not drawn</span>}
                <figcaption>{c.name}<span>{c.line}</span></figcaption>
              </figure>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
