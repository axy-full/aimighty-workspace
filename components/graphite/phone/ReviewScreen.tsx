"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { creditsText } from "@/lib/shell/price-words";
import { reviewProjectTake, type LibraryEntry } from "@/lib/workspace/library";
import type { ReviewState } from "@/lib/workspace/takes";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { judgedLine, reviewQueue, swipeVerdict, takeSpec, takeTitle, versionsOf, type Judgement, type QueuedJudgement } from "./phone-model";

/** How long the judged take slides before the next one shows (the master's 260 ms). */
const SLIDE_MS = 260;
/** A press that moved less than this is a tap (play or pause), never a judgement. */
const TAP_PX = 10;

const generationOf = (entry: LibraryEntry) => (entry.asset.origin === "generation" ? entry.asset.value : null);

/**
 * Full-screen review on the phone (frame C; U1 item 6). The take fills the screen; its versions sit over it;
 * swipe right to approve, left to send it back ("changes", DECISIONS 11), or press the buttons under it.
 *
 * Swiping only judges; it never spends. A judgement is the review trail's own free write
 * (lib/workspace/library.ts › reviewProjectTake, PATCH /api/jobs/:id `{ reviewState }`), the same one the
 * desktop's review makes; nothing paid is ever sent from here. Every judgement has Undo, which writes the
 * take's previous mark back. With no connection the judgement waits in this phone and is sent when it is back.
 *
 * Not drawn here yet: Atomik's note (the take's Verify verdict, stream 5) and Change with words (its own PR).
 */
export function ReviewScreen({ scope, project, items, online, startTake, onQueue, onDone }: {
  scope: string;
  project: Project | null;
  items: readonly LibraryEntry[];
  online: boolean;
  /** The take to open on (`take=`, a generation id). */
  startTake: string | null;
  onQueue: (judgement: QueuedJudgement) => void;
  onDone: () => void;
}) {
  const { toast } = useWorkspace();
  /* What was waiting when the review opened, in order: judged takes leave the queue but keep their place here.
     Takes that arrive later join the end. (State adjusted while rendering, React's pattern for a prop change.) */
  const [order, setOrder] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const waiting = useMemo(() => reviewQueue(items), [items]);
  const more = waiting.map((e) => e.take.id).filter((id) => !order.includes(id));
  if (more.length) {
    const next = [...order, ...more];
    setOrder(next);
    /* The first time the queue fills, a take named in the address opens first. */
    if (!order.length && startTake) {
      const i = next.findIndex((id) => {
        const entry = items.find((e) => e.take.id === id);
        return entry ? generationOf(entry)?.id === startTake : false;
      });
      if (i > 0) setAt(i);
    }
  }

  const current = order[at] ? items.find((e) => e.take.id === order[at]) ?? null : null;
  const versions = useMemo(() => (current ? versionsOf(current, items) : []), [current, items]);
  /* A version picked for this take only: the next take opens on its own. */
  const [chosen, setChosen] = useState<{ take: string; version: string } | null>(null);
  const shown = (chosen && chosen.take === current?.take.id ? versions.find((v) => v.take.id === chosen.version) : null) ?? current;

  const [drag, setDrag] = useState<{ x: number; y: number; dx: number } | null>(null);
  const [hint, setHint] = useState<Judgement | null>(null);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const finished = order.length > 0 && at >= order.length;
  useEffect(() => {
    if (!finished) return;
    toast("Every take here is judged");
    onDone();
  }, [finished, toast, onDone]);

  const write = async (gen: string, state: ReviewState): Promise<string | null> => {
    if (!project) return "Open a project first.";
    if (!online) { onQueue({ projectId: project.id, generationId: gen, state, at: Date.now() }); return null; }
    try { await reviewProjectTake(scope, project.id, gen, state); return null; } catch (e) { return e instanceof Error ? e.message : "The review was not saved."; }
  };

  const judge = async (verdict: Judgement) => {
    if (!shown || hint) return;
    const gen = generationOf(shown);
    if (!gen) return;
    const before = gen.reviewState;
    const index = at;
    const title = takeTitle(shown);
    setHint(verdict);
    const problem = await write(gen.id, verdict);
    if (problem) { setHint(null); toast(problem); return; }
    timer.current = setTimeout(() => { setHint(null); setAt((i) => i + 1); }, SLIDE_MS);
    toast(judgedLine(title, verdict, !online), {
      label: "Undo", kind: "undo",
      run: () => {
        void write(gen.id, before).then((undoProblem) => {
          if (undoProblem) { toast(undoProblem); return; }
          if (timer.current) clearTimeout(timer.current);
          setHint(null);
          setAt(index);
          toast("Undone");
        });
      },
    });
  };

  if (!current || !shown) {
    return (
      <div className="ph-review ph-review--empty" data-testid="phone-review">
        {finished ? null : <p className="ph-quiet" role="status">{items.length ? "Nothing to review in this project." : "Opening the takes…"}</p>}
        <button type="button" className="ph-btn" onClick={onDone}>Done</button>
      </div>
    );
  }
  const gen = generationOf(shown)!;
  const spec = takeSpec(shown);
  const meta = [shown.take.meta, shown.take.credits != null && shown.take.credits > 0 ? `${creditsText(shown.take.credits)} paid` : null].filter(Boolean).join(" · ");
  const offset = hint ? (hint === "approved" ? 40 : -40) : drag ? drag.dx : 0;

  return (
    <div className="ph-review" data-testid="phone-review" data-take={gen.id}>
      <div
        className="ph-review-media"
        data-testid="phone-review-media"
        onPointerDown={(e) => { if (hint) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: e.clientX, y: e.clientY, dx: 0 }); }}
        onPointerMove={(e) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.x }); }}
        onPointerCancel={() => setDrag(null)}
        onPointerUp={(e) => {
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          setDrag(null);
          const verdict = swipeVerdict(dx, dy);
          if (verdict) { void judge(verdict); return; }
          if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX && shown.media === "video" && video.current) {
            if (video.current.paused) void video.current.play().catch(() => {}); else video.current.pause();
          }
        }}
      >
        <div className="ph-review-frame" style={{ transform: `translateX(${offset}px)`, transition: drag ? "none" : undefined }}>
          {shown.media === "video"
            ? <video ref={video} key={shown.take.id} src={shown.url!} muted playsInline loop preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
            : <img key={shown.take.id} src={shown.url!} alt="" draggable={false} />}
        </div>
        {versions.length > 1 ? (
          <div className="ph-review-versions" role="group" aria-label="Versions">
            {versions.map((v) => (
              <button key={v.take.id} type="button" className="ph-chip" aria-pressed={v.take.id === shown.take.id}
                onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onClick={() => current && setChosen({ take: current.take.id, version: v.take.id })}>
                {v.take.version}
              </button>
            ))}
          </div>
        ) : null}
        {spec ? <span className="ph-review-spec">{spec}</span> : null}
        {shown.media === "video" && !playing && !hint ? <span className="ph-review-play" aria-hidden="true">▶</span> : null}
        {hint ? <span className="ph-review-hint" data-kind={hint} role="status">{hint === "approved" ? "Approved" : "Rejected"}</span> : null}
      </div>
      <div className="ph-review-panel" data-testid="mobile-actions">
        <div className="ph-review-head">
          <span className="ph-row-text"><span className="ph-row-title" data-testid="phone-review-title">{takeTitle(shown)}</span>{meta ? <span className="ph-row-line">{meta}</span> : null}</span>
          <span className="ph-row-line ph-nowrap" data-functional-label="">{Math.min(at + 1, order.length)} of {order.length}</span>
        </div>
        <div className="ph-pair">
          <button type="button" className="ph-btn" onClick={() => void judge("changes")} disabled={Boolean(hint)} data-testid="phone-reject">← Reject</button>
          <button type="button" className="ph-btn ph-btn--done" onClick={() => void judge("approved")} disabled={Boolean(hint)} data-testid="phone-approve">Approve →</button>
        </div>
        <button type="button" className="ph-btn" onClick={onDone} data-testid="phone-review-done">Done</button>
        <p className="ph-hint-line">Swipe right to approve, left to reject. Swiping only judges; it never spends.</p>
      </div>
    </div>
  );
}
