"use client";
import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type CSSProperties } from "react";
import LazyMedia from "@/components/LazyMedia";
import { ReleaseTake } from "@/components/graphite/ReleaseTake";
import { Price } from "@/components/graphite/Price";
import { useVerifications } from "@/components/workspace/rig/use-verifications";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import { SAY, referenceRole } from "@/lib/shell/assets";
import { upTo } from "@/lib/shell/price-words";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { askChange } from "../../inspector/change-intent";
import { editQuoteBody } from "../../inspector/inspector-model";
import { GRID_ACTIONS } from "@/lib/v12/board/grid";
import { RejectPanel } from "./RejectPanel";
import { isVerifyCard } from "@/lib/workbench/verify";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { takeChip } from "@/lib/workspace/takes";
import type { BoardCard } from "@/lib/board/types";
import { shotReferenceDrop } from "../accepts";
import { defineCard, type BoardCtx, type CardProps } from "../types";
import type { TakeCardData } from "./shots-derive";
import {
  ESTIMATE_CAP, estimateWords, inFlight, judgeable, needsReview, renderEstimate, verifyNote,
  type ShotTakes, type ShotVersion,
} from "./take-model";
import { useJudge } from "./use-judge";
import { ShotBlockingStrip } from "../../blocking/ShotBlockingStrip";
import { STRIP_HEIGHT } from "../../blocking/shot-blocking";
import { RetryTake } from "./RetryTake";
import "./take.css";

/*
 * A shot's take on the board (README § 3.1 f and g; § 0 rules 6 and 9).
 *
 * - The small card (frame f) shows the shot's current version where its storyboard frame was: the picture,
 *   "Shot N · <framing>", its time line, and while it renders a bar and, only from this workspace's own past
 *   renders of the same engine and settings, "about N min left" (DECISIONS 20). Otherwise the bar is
 *   indeterminate and nothing is claimed.
 * - The large card (frame g) is the take that waits for you: its versions as chips, Reject and Approve, and
 *   Atomik's one-line note from its Verify check. Reject needs a reason, one line of 3 to 500 characters, and saves it
 *   as a note on the take.
 * - States the frames don't draw on a desktop card follow the phone's states frame: a failed take says why,
 *   "Nothing billed" only when that is confirmed (else what the ledger or provider said), and Retry, which hands
 *   the recipe to Make to be priced again; a take held for credits says what it needs, with Release.
 */

/* Buttons inside a canvas card: no drag, no pan, and a double-click on them is not the card's. */
function Btn({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`gx-take-btn nodrag nopan${className ? ` ${className}` : ""}`} onDoubleClick={(e) => e.stopPropagation()} />;
}

/** Re-renders every few seconds while a take renders, so its estimate moves. */
function useNow(active: boolean, every = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

/** The picture: the version's media, else the shot card's own frame, else a quiet face. */
function Picture({ version, frame, name }: { version: ShotVersion | null; frame: ShotTakes["frame"]; name: string }) {
  const media = version && version.url && (version.media === "image" || version.media === "video") && !inFlight(version) && version.status !== "failed"
    ? { url: version.url, kind: version.media } : frame;
  if (!media) return <span className="gx-take-face" aria-hidden="true" />;
  return <LazyMedia url={media.url} kind={media.kind} alt="" name={name} preview={false} />;
}

function Progress({ version, typicalMs }: { version: ShotVersion; typicalMs: number | null }) {
  const rendering = version.status === "rendering" && version.stage === "rendering";
  const now = useNow(rendering);
  if (version.status === "rendering" && version.stage === "queued") return <span className="gx-take-badge" data-testid="take-queued">Queued</span>;
  if (!rendering) return null;
  const estimate = renderEstimate(version.createdAt, typicalMs, now);
  return (
    <>
      <span className="gx-take-bar" role="progressbar" aria-label={estimate ? estimateWords(estimate) : "Rendering"}
        {...(estimate ? { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(estimate.fraction * 100) } : {})}
        data-indeterminate={estimate ? undefined : ""} style={estimate ? { width: `${Math.min(ESTIMATE_CAP, estimate.fraction) * 100}%` } : undefined} data-testid="take-progress" />
      {estimate ? <span className="gx-take-badge" data-testid="take-estimate">{estimateWords(estimate)}</span> : null}
    </>
  );
}

/** What a failed, held or rejected take says under its line. Nothing for a take that is fine. */
function StatusLine({ version, ctx }: { version: ShotVersion; ctx: BoardCtx }) {
  const recreate = useRecreate();
  if (version.status === "failed") {
    const cancelled = version.entry.take.cancelled === true;
    return (
      <div className="gx-take-status" data-tone={cancelled ? "idle" : "failed"} data-testid="take-failed">
        <span className="gx-take-why">{version.reason ?? (cancelled ? "Stopped before it rendered" : "Did not render")}</span>
        {version.nothingBilled
          ? <span className="gx-take-charge" data-testid="take-nothing-billed">Nothing billed</span>
          : version.charge ? <span className="gx-take-charge" data-testid="take-charge">{version.charge}</span> : null}
        {version.retry && !ctx.offline ? <RetryTake entry={version.entry} scope={ctx.scope} className="gx-take-btn" onRetry={() => recreate(version.entry)} /> : null}
      </div>
    );
  }
  if (version.status === "held") {
    return (
      <div className="gx-take-status" data-tone="waiting" data-testid="take-held">
        <span className="gx-take-why">{takeChip(version.entry.take)?.label ?? "Held · needs credits"}</span>
        <span className="nodrag nopan"><ReleaseTake entry={version.entry} place="tile" onReleased={() => refreshProjectLibrary(ctx.scope, ctx.project.id)} /></span>
      </div>
    );
  }
  if (version.status === "changes") return <div className="gx-take-status" data-tone="idle" data-testid="take-rejected"><span className="gx-take-why">Rejected · nothing more spent</span></div>;
  return null;
}

const hasStatus = (v: ShotVersion | null) => Boolean(v && (v.status === "failed" || v.status === "held" || v.status === "changes"));

/**
 * The new interface's shot card, Approve · Reject (prototype L576; docs/redesign/inventory.md § 6.6): a finished take is judged on
 * its card, by the same paths as the review card and the Inspector (use-judge: free, a person's call). Reject asks why, as it
 * always has: the reason covers the card while it is asked.
 */
function GridActions({ row, version, ctx }: { row: ShotTakes; version: ShotVersion; ctx: BoardCtx }) {
  const judge = useJudge(ctx.scope, ctx.project.id, ctx.toast);
  const [rejecting, setRejecting] = useState(false);
  const off = ctx.offline || Boolean(judge.busy);
  const approved = version.status === "approved";
  const rejected = version.status === "changes";
  return (
    <>
      <div className="gx-take-grid-acts" data-testid="take-grid-actions">
        <Btn className="gx-take-btn--hot" disabled={off || approved} title={ctx.offline ? "Needs a connection" : "Approve · A — Mark this take as good; the next step can use it. Free."}
          onClick={(e) => { e.stopPropagation(); void judge.approve(row, version); }} data-testid="take-approve">{approved ? "Approved" : "Approve"}</Btn>
        <Btn disabled={off || rejected} title={ctx.offline ? "Needs a connection" : "Reject — Say what is wrong; nothing more is spent."}
          onClick={(e) => { e.stopPropagation(); setRejecting(true); }} aria-expanded={rejecting} data-testid="take-reject">{rejected ? "Rejected" : "Reject"}</Btn>
      </div>
      {rejecting ? (
        <div className="gx-take-grid-reject">
          <RejectPanel busy={Boolean(judge.busy)} onCancel={() => setRejecting(false)}
            onReject={(reason) => { void judge.reject(row, version, reason).then((ok) => { if (ok) setRejecting(false); }); }} />
        </div>
      ) : null}
    </>
  );
}

export function TakeCard({ data, ctx }: CardProps<TakeCardData>) {
  const { row } = data;
  const v = row.shown;
  const judging = Boolean(data.grid && v && judgeable(v) && !hasStatus(v) && !inFlight(v));
  return (
    <article className="gx-take" style={{ "--gx-take-well": `${wellHeight(340, ctx.project.aspect)}px` } as CSSProperties} data-status={v?.status ?? "empty"} data-dim={v?.status === "changes" || undefined}
      aria-label={[row.title, v ? `${v.label}` : "no take yet", v && needsReview(v) ? "needs review" : null].filter(Boolean).join(" · ")} data-testid="take-card" data-node={row.nodeId}>
      <div className="gx-take-media">
        <Picture version={v} frame={row.frame} name={row.title} />
        {v ? <Progress version={v} typicalMs={row.typicalMs} /> : null}
        {row.anchor ? <span className="gx-take-tag" data-anchor={row.anchor === "anchor" || undefined} data-testid="take-anchor">{row.anchor === "anchor" ? "LOOK ANCHOR" : "FOLLOWS SHOT 1"}</span> : null}
        {v && v.media === "video" && judgeable(v) ? <span className="gx-take-play" aria-hidden="true">▶</span> : null}
        {v?.status === "failed" ? <span className="gx-take-glyph" aria-hidden="true">!</span> : null}
      </div>
      <div className="gx-take-foot">
        <div className="gx-take-name">{row.title}</div>
        <div className="gx-take-line">{row.line}</div>
        {v && hasStatus(v) ? <StatusLine version={v} ctx={ctx} /> : null}
        {data.blocking ? <ShotBlockingStrip ctx={ctx} nodeId={row.nodeId} index={row.index} view={data.blocking} /> : null}
        {judging && v ? <GridActions row={row} version={v} ctx={ctx} /> : null}
      </div>
    </article>
  );
}

/* ── Frame g: the take that waits for you ───────────────────────────────── */

function VersionChips({ row, current, onPick }: { row: ShotTakes; current: ShotVersion; onPick: (v: ShotVersion) => void }) {
  if (row.versions.length < 2) return null;
  return (
    <div className="gx-take-chips" role="group" aria-label="Versions">
      {row.versions.map((v) => (
        <Btn key={v.genId} className="gx-take-chip" aria-pressed={v.genId === current.genId} onClick={(e) => { e.stopPropagation(); onPick(v); }} data-testid="take-version">
          {v.label}{v.status === "approved" ? " · approved" : ""}
        </Btn>
      ))}
    </div>
  );
}

export function ReviewTakeCard({ data, ctx }: CardProps<TakeCardData>) {
  const { row } = data;
  const judge = useJudge(ctx.scope, ctx.project.id, ctx.toast);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const current = row.versions.find((v) => v.genId === pickedId) ?? row.shown;
  const checked = ctx.project.nodes.some(isVerifyCard);
  const { list } = useVerifications(ctx.scope, checked ? ctx.project.id : null);
  const note = useMemo(() => (current ? verifyNote(list, current.id) : null), [list, current]);
  /* Change with words on a clip: the free quote Seedance Edit's panel asks, read while the take waits (nothing is sent). */
  const editBody = current ? editQuoteBody(current, ctx.project.productionProjectId) : null;
  const editQuote = useStageQuotes(ctx.scope, editBody && !ctx.offline && judgeable(current!) ? { edit: { body: editBody } } : {}).quotes.edit;
  const editPrice = upTo(editQuote?.credits);
  if (!current) return null;
  const open = judgeable(current) && !ctx.offline;
  const role = referenceRole(current.media === "image" || current.media === "video" ? current.media : null);
  const cancel = () => setRejecting(false);
  const reject = (reason: string) => { setPickedId(current.genId); void judge.reject(row, current, reason).then((ok) => { if (ok) cancel(); }); };
  const change = () => {
    setPickedId(current.genId);
    if (current.media === "video") { askChange(current.genId); ctx.openInspector(`take-review:${row.nodeId}`); return; }
    ctx.openMake("image");
  };
  const referenceIt = () => {
    if (!role) return;
    sendReference({ id: current.id, name: current.entry.take.name });
    ctx.openMake(current.media === "video" ? "video" : "image");
    ctx.toast(SAY.referenced(current.entry.take.name, role));
  };
  return (
    <article className="gx-take gx-take--review" data-rejecting={rejecting || undefined} style={{ "--gx-take-well": `${wellHeight(560, ctx.project.aspect)}px` } as CSSProperties} data-status={current.status} data-dim={current.status === "changes" || undefined} aria-label={`${row.title} · ${current.label}`} data-testid="take-review">
      <div className="gx-take-media">
        <Picture version={current} frame={row.frame} name={row.title} />
        <VersionChips row={row} current={current} onPick={(v) => { setPickedId(v.genId); cancel(); }} />
        {current.media === "video" && judgeable(current) ? <span className="gx-take-play gx-take-play--lg" aria-hidden="true">▶</span> : null}
      </div>
      <div className="gx-take-foot gx-take-foot--review">
        <div className="gx-take-head">
          <div className="gx-take-heading">
            <div className="gx-take-title">{`Shot ${row.index} · ${row.name} · ${current.label}`}</div>
            <div className="gx-take-engine">{current.engine}</div>
          </div>
          {rejecting ? null : (
            <div className="gx-take-acts">
              <Btn onClick={(e) => { e.stopPropagation(); setRejecting(true); }} disabled={!open || current.status === "changes" || Boolean(judge.busy)} aria-expanded={false}
                title={ctx.offline ? "Needs a connection" : undefined} data-testid="take-reject">{current.status === "changes" ? "Rejected" : "Reject"}</Btn>
              <Btn className="gx-take-btn--approve" onClick={(e) => { e.stopPropagation(); setPickedId(current.genId); void judge.approve(row, current); }} disabled={!open || current.status === "approved" || Boolean(judge.busy)}
                title={ctx.offline ? "Needs a connection" : undefined} data-testid="take-approve">{current.status === "approved" ? "Approved" : "Approve"}</Btn>
            </div>
          )}
        </div>
        {rejecting ? (
          <RejectPanel busy={Boolean(judge.busy)} onReject={reject} onCancel={cancel} />
        ) : (
          <>
            {note ? <div className="gx-take-note" data-testid="take-note"><span className="gx-take-spark" aria-hidden="true">✦</span><span>{note.text}</span></div> : <div className="gx-take-note" aria-hidden="true" />}
            <div className="gx-take-more">
              {judgeable(current) && current.entry.asset.origin === "generation" ? (
                <Btn onClick={(e) => { e.stopPropagation(); change(); }} disabled={ctx.offline} title={ctx.offline ? "Needs a connection" : undefined} data-testid="take-change-words">
                  Change with words{editPrice ? <> · <Price value={editPrice} testId="take-change-price" /></> : null}
                </Btn>
              ) : null}
              {role && judgeable(current) ? <Btn onClick={(e) => { e.stopPropagation(); referenceIt(); }} data-testid="take-use-ref">Use as reference</Btn> : null}
              <Btn onClick={(e) => { e.stopPropagation(); ctx.glide({ card: `versions:${row.nodeId}` }); }} data-testid="take-versions-go">Versions</Btn>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/* ── Sizes (README § 3.1: 340 in the Shots group; 560 when it stands alone) ──── */

const RATIO_MIN = 1;
const RATIO_MAX = 16 / 9;
/** The media well's height for the project's aspect: 16:9 as drawn, never taller than square (portrait media letterboxes). */
export function wellHeight(width: number, aspect: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  const ratio = m && Number(m[1]) > 0 && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : RATIO_MAX;
  return Math.round(width / Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)));
}
/** Name, time line and padding under the picture (8 + 20 + 35 + 10). */
const FOOT = 73;
const STATUS = 40;
/** The row under the note: Change with words, Use as reference, Versions (8 gap + 28 button). */
const MORE = 36;

/** A shot card on the new interface's grid: 260 wide, its picture at the board's aspect, the name and line, and the row Approve · Reject (or a status) takes. */
export function gridTakeHeight(data: TakeCardData, aspect: string): number {
  return wellHeight(260, aspect) + FOOT + GRID_ACTIONS + (data.blocking ? STRIP_HEIGHT : 0);
}

export const takeDef = defineCard<TakeCardData>({
  kind: "take",
  size: (data, at) => ({ w: 340, h: wellHeight(340, at.aspect) + FOOT + (hasStatus(data.row.shown) ? STATUS : 0) + (data.blocking ? STRIP_HEIGHT : 0) }),
  Card: TakeCard,
  /* A Library file dropped on a shot becomes its reference. The board's plain take card had this; this definition replaces it, so it carries the rule. */
  accepts: shotReferenceDrop,
  onOpen: (card: BoardCard<TakeCardData>, ctx: BoardCtx) => {
    const v = card.data.row.shown;
    if (v && judgeable(v)) ctx.openReview(v.id); else ctx.openInspector(card.id);
  },
});

export const reviewTakeDef = defineCard<TakeCardData>({
  kind: "take-review",
  /* Title, engine line and buttons (12 + 42 + 10), the note line (21) and the bottom padding (14). */
  size: (_data, at) => ({ w: 560, h: wellHeight(560, at.aspect) + 99 + MORE }),
  Card: ReviewTakeCard,
  onOpen: (card: BoardCard<TakeCardData>, ctx: BoardCtx) => {
    const v = card.data.row.shown;
    if (v && judgeable(v)) ctx.openReview(v.id);
  },
});

