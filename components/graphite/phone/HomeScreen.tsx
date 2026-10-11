"use client";
import { spendAttrsOf } from "@/lib/spend";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { countsByDraft, sortQueue, type QueueItem } from "@/lib/control-room/queue";
import type { ApprovalsState } from "@/lib/control-room/use-approvals";
import { moving, type TrayJob } from "@/lib/jobsTray";
import { creditsText, priceWords } from "@/lib/shell/price-words";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import type { ProjectSummary } from "@/lib/workspace/data";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { useProjectCards, useProjectCover, type ProjectCardModel } from "../home/use-project-cards";
import { Price } from "../Price";
import { CheckAgain } from "../CheckAgain";
import { CHECK_LINE } from "@/lib/demo/sample";
import { Eyebrow } from "./PhoneChrome";
import { NotifyButton } from "./NotifyButton";
import { itemsLine, reviewCountLine, reviewQueue } from "./phone-model";

/** Said on a sample production's paid buttons (DECISIONS 38). */
export const SAMPLE_LINE = "Sample production · nothing here spends credits";
/** Said on a control that spends while the phone has no connection (README § 3.6 states). */
export const NEEDS_CONNECTION = "Needs a connection";

const when = (at: number, now: number) => {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/**
 * Home on the phone (frame A): "Needs you" first, then the projects.
 *
 * Needs you is three kinds of row, in this order:
 *  - what waits for a person's approval, from stream 8's one queue (lib/control-room/queue.ts), with its price
 *    as the button. A press goes through that item's own existing person-only route (lib/control-room/approve.ts)
 *    at that price; nothing new approves anything. An item over the per-shot rule says it needs an admin, a sample
 *    item says nothing in it spends, and a short balance offers Top up instead;
 *  - takes rendering, from the jobs tray the header already reads, with "Notify me";
 *  - the open project's takes to review, which open the full-screen review.
 *
 * Projects are stream 2's project cards (components/graphite/home/use-project-cards.ts): the same lines as the
 * desktop Home, counted from the same queue.
 */
export function HomeScreen({ scope, approvals, projects, projectsError = null, onRetryProjects, project, items, online, now, onReview, onPlan, onThread, onProject, onTopUp, start = null }: {
  scope: string;
  approvals: ApprovalsState;
  projects: readonly ProjectSummary[];
  /** The server's words when the projects list could not be read, or null. */
  projectsError?: string | null;
  /** Reads the projects list again (a read, never a paid retry). */
  onRetryProjects?: () => void;
  project: Project | null;
  items: readonly LibraryEntry[];
  online: boolean;
  now: number;
  onReview: () => void;
  /** A plan (a proposed build) opens the plan screen; a single item approves in place. */
  onPlan: (item: QueueItem) => void;
  /** An Atomik plan's step opens its plan (the thread in Atomik's sheet), as Open does on the desktop; it never approves here. */
  onThread: (item: QueueItem) => void;
  onProject: (id: string) => void;
  onTopUp: () => void;
  /** "What are we making?" (StartBrief): under Needs you, above the projects. */
  start?: ReactNode;
}) {
  const tray = useJobsTray();
  const queue = useMemo(() => sortQueue(approvals.items), [approvals.items]);
  const renders = useMemo(() => (tray?.jobs ?? []).filter((job) => moving(job) || job.stage === "queued"), [tray?.jobs]);
  const review = useMemo(() => reviewQueue(items).length, [items]);
  const counts = useMemo(() => (approvals.status === "ready" ? countsByDraft(approvals.items) : null), [approvals.status, approvals.items]);
  const cards = useProjectCards(projects, now, counts);
  const total = queue.length + renders.length + (review ? 1 : 0);
  const loading = approvals.status === "loading" && !queue.length;
  return (
    <div className="ph-home" data-testid="phone-home">
      <section className="ph-section" aria-label="Needs you">
        <Eyebrow aside={loading ? null : itemsLine(total)}>Needs you</Eyebrow>
        {approvals.error ? (
          <div className="ph-row ph-row--note" role="status" data-testid="phone-approvals-error">
            <span className="ph-row-text"><span className="ph-row-line">{approvals.error}</span></span>
            <button type="button" className="ph-btn" onClick={() => void approvals.refresh()}>Try again</button>
          </div>
        ) : null}
        {queue.map((item) => <ApprovalRow key={item.id} item={item} approvals={approvals} online={online} now={now} onTopUp={onTopUp} onPlan={onPlan} onThread={onThread} />)}
        {renders.map((job) => <RenderRow key={job.id} job={job} />)}
        {review && project ? (
          <div className="ph-row" data-testid="phone-review-row">
            <span className="ph-dot ph-dot--done" aria-hidden="true" />
            <span className="ph-row-text"><span className="ph-row-title">{reviewCountLine(review)}</span><span className="ph-row-line">{project.name} · swipe to judge</span></span>
            <button type="button" className="ph-btn" onClick={onReview} data-testid="phone-open-review">Review</button>
          </div>
        ) : null}
        {loading ? <p className="ph-quiet" role="status">Reading what needs you…</p> : !total && !approvals.error ? <p className="ph-quiet" data-testid="phone-nothing">Nothing waiting</p> : null}
      </section>
      {start}
      <section className="ph-section" aria-label="Projects">
        <Eyebrow>Projects</Eyebrow>
        {projectsError ? (
          <div className="ph-row ph-row--note" role="status" data-testid="phone-projects-error">
            <span className="ph-row-text"><span className="ph-row-line">{projectsError}</span></span>
            <button type="button" className="ph-btn" onClick={() => onRetryProjects?.()} data-testid="phone-projects-error-retry">Try again</button>
          </div>
        ) : null}
        <div className="ph-projects">
          {cards.map((card) => <ProjectCard key={card.id} scope={scope} card={card} open={card.id === project?.id} onOpen={() => onProject(card.id)} />)}
        </div>
      </section>
    </div>
  );
}

function ApprovalRow({ item, approvals, online, now, onTopUp, onPlan, onThread }: { item: QueueItem; approvals: ApprovalsState; online: boolean; now: number; onTopUp: () => void; onPlan: (item: QueueItem) => void; onThread: (item: QueueItem) => void }) {
  const { toast } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const short = (item.shortBy ?? 0) > 0;
  const line = [item.project.name, item.where, item.step ? `step ${item.step.n} of ${item.step.of}` : null, when(item.at, now)].filter(Boolean).join(" · ");
  const note = item.sample ? (item.unchecked ? CHECK_LINE : SAMPLE_LINE) : short ? `Short by ${creditsText(item.shortBy!)}` : item.needsAdmin && !item.canApprove ? "Needs an admin" : !item.canApprove ? item.why : item.note;
  const approve = async () => {
    setBusy(true);
    const out = await approvals.approve(item);
    if (!live.current) return;
    setBusy(false);
    const words = priceWords(item.price);
    const held = item.approve?.kind === "release" || item.approve?.kind === "board-render";
    toast(out.ok ? `${item.title} approved${words && words !== "free" ? ` · ${words}${held ? " held" : ""}` : ""}` : out.reason);
  };
  let action: React.ReactNode;
  /* An Atomik plan's step is approved with its plan's Continue, never from this row: Open shows the plan, as on the desktop. */
  if (item.approve?.kind === "thread") action = (
    <button type="button" className="ph-btn" onClick={() => onThread(item)} aria-label={`Open the plan: ${item.title}`} data-testid="phone-row-open">Open</button>
  );
  /* The sample spends nothing: its row says so in its line, and offers no priced button. */
  else if (item.sample) action = item.unchecked ? <CheckAgain className="ph-btn" /> : null;
  else if (short && item.canApprove) action = <button type="button" className="ph-btn ph-btn--hot" onClick={onTopUp} data-testid="phone-row-topup">Top up</button>;
  else if (!item.canApprove || !item.approve) action = null;
  /* A plan is several steps priced together: it opens its approval screen rather than approving in place. */
  else if (item.approve.kind === "board-approve") action = (
    <button type="button" className="ph-btn ph-btn--hot ph-btn--price" onClick={() => onPlan(item)} aria-label={`Open the plan: ${item.title}`} data-testid="phone-row-plan">
      {item.price ? <Price value={item.price} /> : "Open"}
    </button>
  );
  else if (!online) action = <button type="button" className="ph-btn" disabled>{NEEDS_CONNECTION}</button>;
  else action = (
    <button type="button" className="ph-btn ph-btn--hot ph-btn--price" disabled={busy} aria-busy={busy || undefined} onClick={() => void approve()} data-testid="phone-row-approve" {...spendAttrsOf(item.price)}>
      {item.price ? <Price value={item.price} /> : "Approve"}
    </button>
  );
  return (
    <div className="ph-row" data-testid="phone-approval-row" data-source={item.source}>
      <span className="ph-dot ph-dot--wait" aria-hidden="true" />
      <span className="ph-row-text">
        <span className="ph-row-title">{item.title}</span>
        <span className="ph-row-line">{line}</span>
        {note ? <span className={`ph-row-line${item.needsAdmin || short ? " ph-row-line--warn" : ""}`}>{note}</span> : null}
      </span>
      {action}
    </div>
  );
}

function RenderRow({ job }: { job: TrayJob }) {
  const pct = typeof job.progress === "number" && job.progress >= 0 && job.progress < 1 ? Math.round(job.progress * 100) : null;
  return (
    <div className="ph-row" data-testid="phone-render-row">
      <span className="ph-dot ph-dot--live" aria-hidden="true" />
      <span className="ph-row-text">
        <span className="ph-row-title">{job.name}</span>
        <span className="ph-row-line">{[job.projectName, job.label].filter(Boolean).join(" · ")}</span>
        {/* No engine reports progress today (lib/jobsTray.ts): the bar moves without claiming how far it is. */}
        <span className="ph-bar" role="progressbar" aria-label={job.label} aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <span className={pct === null ? "ph-bar-fill ph-bar-fill--busy" : "ph-bar-fill"} style={pct === null ? undefined : { width: `${pct}%` }} />
        </span>
      </span>
      <NotifyButton />
    </div>
  );
}

function ProjectCard({ scope, card, open, onOpen }: { scope: string; card: ProjectCardModel; open: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true); }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  const cover = useProjectCover(scope, card.id, visible);
  return (
    <button ref={ref} type="button" className="ph-project" aria-current={open || undefined} onClick={onOpen} data-testid="phone-project">
      <span className="ph-project-pic" aria-hidden="true">
        {cover?.kind === "image" ? <img src={cover.url} alt="" loading="lazy" /> : cover?.kind === "video" ? <video src={cover.url} muted playsInline preload="metadata" /> : null}
      </span>
      <span className="ph-project-foot">
        <span className="ph-row-text">
          <span className="ph-project-name">{card.name}</span>
          {card.line ? <span className="ph-row-line" data-tone={card.line.tone}>{card.line.text}</span> : card.meta ? <span className="ph-row-line">{card.meta}</span> : null}
        </span>
        <span className="ph-chev" aria-hidden="true">›</span>
      </span>
    </button>
  );
}
