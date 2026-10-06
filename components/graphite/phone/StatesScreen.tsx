"use client";
import { useMemo } from "react";
import LazyMedia from "@/components/LazyMedia";
import { ReleaseTake } from "@/components/graphite/ReleaseTake";
import { creditsText } from "@/lib/shell/price-words";
import type { RecipeSource } from "@/lib/shell/recipe";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import { useRecreatePrice } from "@/lib/shell/use-recreate-price";
import type { SpendPrice } from "@/lib/spend";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import type { Project } from "@/lib/workbench/studio";
import { estimateWords, inFlight, renderEstimate, renderKey, shotVersion, typicalRenderMs, type ShotVersion } from "../board/cards/take/take-model";
import { SpendButton } from "../SpendButton";
import { NEEDS_CONNECTION } from "./HomeScreen";
import { NotifyButton } from "./NotifyButton";
import { Eyebrow } from "./PhoneChrome";
import { judgedLine, reviewQueue, takeTitle, type QueuedJudgement } from "./phone-model";
import { HELD_LINE } from "./PlanScreen";

/**
 * The shots in their states (design/particl-graphite, Phone frames H; `screen=states`): what is rendering, what
 * failed, what is held for credits, and what a phone with no connection can still do. Each card is a shot's
 * newest take (a take on no shot stands alone), read from the project's Library the way the board reads it
 * (take-model.ts), and says only what the ledger and the provider said:
 *  - Rendering: a bar (a figure and "about N min left" only from this workspace's own past renders, else a bar that
 *    moves without claiming how far), and Notify me when done;
 *  - Failed: why, "Nothing billed" only when that is confirmed (else what the ledger or provider said), and Retry at
 *    the price Make will show for the same recipe. Retry opens Make with that recipe; nothing is sent from here;
 *  - Held for credits: what it needs, Release at that price (the existing release, never charged twice), Top up
 *    while the balance is short, and Hold;
 *  - Offline: judging queues and is sent when the phone is back; anything that spends waits ("Needs a connection").
 */

type Props = {
  scope: string;
  project: Project | null;
  items: readonly LibraryEntry[];
  online: boolean;
  now: number;
  balance: number | null;
  onTopUp: () => void;
  onQueue: (judgement: QueuedJudgement) => void;
};

/** One card: a shot's newest take (or a take on no shot), with its typical render time from this workspace's own past renders. */
type Row = { key: string; title: string; v: ShotVersion; typicalMs: number | null };

/** The master's order: what is rendering, then what failed, then what is held for credits. */
const RANK: Record<string, number> = { rendering: 0, failed: 1, held: 2 };

function stateRows(items: readonly LibraryEntry[]): Row[] {
  const newest = new Map<string, LibraryEntry>();
  for (const entry of items) {
    if (entry.asset.origin !== "generation" || entry.asset.value.kind === "model") continue;
    const g = entry.asset.value;
    const key = g.shotId || entry.take.id;
    const kept = newest.get(key);
    if (!kept || (kept.asset.origin === "generation" && (g.version > kept.asset.value.version || (g.version === kept.asset.value.version && g.createdAt > kept.asset.value.createdAt)))) newest.set(key, entry);
  }
  return [...newest.entries()].flatMap(([key, entry]) => {
    const v = shotVersion(entry);
    if (!v || !(inFlight(v) || v.status === "failed")) return [];
    const typicalMs = v.status === "rendering" && v.stage === "rendering" && entry.asset.origin === "generation" ? typicalRenderMs(renderKey(entry.asset.value), items) : null;
    return [{ key, title: takeTitle(entry).split(" · ")[0], v, typicalMs }];
  }).sort((a, b) => (RANK[a.v.status] ?? 3) - (RANK[b.v.status] ?? 3) || b.v.createdAt - a.v.createdAt);
}

export function StatesScreen({ scope, project, items, online, now, balance, onTopUp, onQueue }: Props) {
  const cards = useMemo(() => stateRows(items), [items]);
  const waiting = !online ? reviewQueue(items)[0] : undefined;
  return (
    <main className="ph-scroll" data-testid="mobile-scroll">
      <div className="ph-states" data-testid="phone-states">
        <Eyebrow>{project ? `Shots · ${project.name}` : "Shots"}</Eyebrow>
        {project ? cards.map((row) => <StateCard key={row.key} scope={scope} project={project} row={row} online={online} now={now} balance={balance} onTopUp={onTopUp} />) : null}
        {project && waiting ? <OfflineCard entry={waiting} project={project} onQueue={onQueue} /> : null}
        {!cards.length && !waiting ? <p className="ph-quiet" role="status" data-testid="phone-states-none">Nothing is rendering, held or failed in this project.</p> : null}
      </div>
    </main>
  );
}

function Picture({ v, name }: { v: ShotVersion; name: string }) {
  const media = v.url && (v.media === "image" || v.media === "video") && !inFlight(v) && v.status !== "failed" ? { url: v.url, kind: v.media } : null;
  return media ? <LazyMedia url={media.url} kind={media.kind} alt="" name={name} preview={false} /> : <span className="ph-state-face" aria-hidden="true" />;
}

const STAGE = { rendering: "Rendering", queued: "Queued", held: "Held" } as const;

function StateCard({ scope, project, row, online, now, balance, onTopUp }: { scope: string; project: Project; row: Row; online: boolean; now: number; balance: number | null; onTopUp: () => void }) {
  const { toast } = useWorkspace();
  const v = row.v;
  const rendering = v.status === "rendering";
  const estimate = rendering && v.stage === "rendering" ? renderEstimate(v.createdAt, row.typicalMs, now) : null;
  const failed = v.status === "failed";
  const cancelled = failed && v.entry.take.cancelled === true;
  const held = v.status === "held";
  const short = held && v.needs != null && balance != null && balance < v.needs ? v.needs - balance : null;
  const badge = failed ? (cancelled ? "Stopped" : "Failed") : held ? "Held · needs credits" : v.stage === "queued" ? "Queued" : null;
  const meta = [v.engine, estimate ? estimateWords(estimate) : null].filter(Boolean).join(" · ");
  return (
    <article className="ph-state" data-status={v.status} data-testid="phone-state-card" aria-label={`${row.title} · ${v.label} · ${failed ? "failed" : held ? "held" : STAGE[v.stage ?? "rendering"].toLowerCase()}`}>
      <div className="ph-state-media">
        <Picture v={v} name={row.title} />
        {rendering && v.stage === "rendering" ? (
          <>
            <span className="ph-state-over" data-testid="phone-state-rendering">{estimate ? `Rendering · ${Math.round(estimate.fraction * 100)}%` : "Rendering"}</span>
            <span className="ph-state-bar" role="progressbar" aria-label={estimate ? estimateWords(estimate) : "Rendering"} {...(estimate ? { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(estimate.fraction * 100) } : {})}>
              <span className={estimate ? "ph-bar-fill" : "ph-bar-fill ph-bar-fill--busy"} style={estimate ? { width: `${Math.round(estimate.fraction * 100)}%` } : undefined} />
            </span>
          </>
        ) : null}
        {badge ? <span className="ph-state-badge" data-tone={failed ? "failed" : held ? "waiting" : "idle"}>{badge}</span> : null}
      </div>
      <div className="ph-state-foot">
        <div className="ph-state-head">
          <span className="ph-row-text"><span className="ph-row-title">{`${row.title} · ${v.label}`}</span><span className="ph-row-line">{meta}</span></span>
          {failed ? (v.nothingBilled ? <span className="ph-state-fig" data-tone="done" data-testid="phone-state-nothing-billed">Nothing billed</span> : v.charge ? <span className="ph-state-fig" data-testid="phone-state-charge">{v.charge}</span> : null)
            : held && v.needs != null ? <span className="ph-state-fig" data-tone="waiting">{creditsText(v.needs)}{balance != null ? ` · balance ${creditsText(balance)}` : ""}</span> : null}
        </div>
        {failed ? <p className="ph-row-line" data-testid="phone-state-why">{v.reason ?? (cancelled ? "Stopped before it rendered" : "Did not render")}</p> : null}
        {held ? <p className="ph-row-line" data-testid="phone-state-needs">{short != null ? `Short by ${creditsText(short)}. Nothing is spent until you top up and release.` : "Waiting for credits. Nothing is spent until you release it."}</p> : null}
        <div className="ph-state-acts">
          {rendering ? <NotifyButton label="Notify me when done" /> : null}
          {failed && v.retry ? <RetryButton scope={scope} project={project} v={v} online={online} /> : null}
          {held ? (
            <>
              {!online ? <button type="button" className="ph-btn" disabled>{NEEDS_CONNECTION}</button> : <span className="ph-state-release"><ReleaseTake entry={v.entry} place="tile" onReleased={() => refreshProjectLibrary(scope, project.id)} /></span>}
              {short != null ? <button type="button" className="ph-btn ph-btn--hot" onClick={onTopUp} data-testid="phone-state-topup">Top up</button> : null}
              <button type="button" className="ph-btn" onClick={() => toast(HELD_LINE)} data-testid="phone-state-hold">Hold</button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Retry: the take's recipe handed to Make (which prices it again on its own button), at the price Make will show. */
function RetryButton({ scope, project, v, online }: { scope: string; project: Project; v: ShotVersion; online: boolean }) {
  const recreate = useRecreate();
  const read = useRecreatePrice(scope, v.entry.take.id, v.entry.asset.origin === "generation" ? (v.entry.asset.value as RecipeSource) : null, project.aspect);
  const price: SpendPrice = read?.state === "ready" ? (read.approximate ? { upTo: read.credits } : { cr: read.credits }) : null;
  return (
    <SpendButton className="ph-btn ph-btn--hot" label="Retry" price={price} disabled={!online} title={!online ? NEEDS_CONNECTION : read?.state === "unavailable" ? read.reason : undefined}
      onClick={() => recreate(v.entry)} data-testid="phone-state-retry" />
  );
}

/** A phone with no connection: the take that waits for judging can still be approved or sent back; it is sent when the phone is back. */
function OfflineCard({ entry, project, onQueue }: { entry: LibraryEntry; project: Project; onQueue: (judgement: QueuedJudgement) => void }) {
  const { toast } = useWorkspace();
  const gen = entry.asset.origin === "generation" ? entry.asset.value : null;
  const v = shotVersion(entry);
  if (!gen || !v) return null;
  const title = takeTitle(entry);
  const judge = (state: "approved" | "changes") => {
    onQueue({ projectId: project.id, generationId: gen.id, state, at: Date.now() });
    toast(judgedLine(title, state === "approved" ? "approved" : "changes", true));
  };
  return (
    <article className="ph-state" data-status="offline" data-testid="phone-state-offline">
      <div className="ph-state-media">
        <Picture v={v} name={title} />
        <span className="ph-state-badge" data-tone="idle">Offline</span>
      </div>
      <div className="ph-state-foot">
        <div className="ph-state-head">
          <span className="ph-row-text"><span className="ph-row-title">{title}</span><span className="ph-row-line">Reviews queue until you’re back online</span></span>
          <span className="ph-state-fig">{NEEDS_CONNECTION}</span>
        </div>
        <p className="ph-row-line">Approve or reject now; it is sent when you are back online. Anything that spends credits waits: prices and the balance are checked first.</p>
        <div className="ph-state-acts">
          <button type="button" className="ph-btn ph-btn--done" onClick={() => judge("approved")} data-testid="phone-state-approve">Approve → queued</button>
          <button type="button" className="ph-btn" onClick={() => judge("changes")} data-testid="phone-state-reject">Reject → queued</button>
          <button type="button" className="ph-btn" disabled data-testid="phone-state-change">Change with words · {NEEDS_CONNECTION}</button>
        </div>
      </div>
    </article>
  );
}
