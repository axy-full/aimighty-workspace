"use client";
import { spendAttrsOf } from "@/lib/spend";
import { useEffect } from "react";
import type { Step } from "@/lib/atomik";
import { ProjectProvider, useProject } from "@/lib/projectContext";
import { AtomikProvider, useAtomik } from "@/components/atomik/AtomikProvider";
import { openAtomikChat } from "@/lib/shell/use-skills";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { approvalsChanged } from "@/lib/control-room/approve";
import { exact, upTo } from "@/lib/shell/price-words";
import { Price, usePriceTitle } from "../Price";

/**
 * A plan's next step, approved from the queue with the plan's own Continue
 * (components/atomik/AtomikProvider.tsx), exactly as the Skills page does it
 * today: the step is priced live by the route that will render it, Continue
 * sends that price as the ceiling, and nothing else in the plan runs. No money
 * path is added or changed here; this only opens the existing checkpoint for
 * the one thread the row names.
 */
export function ThreadCheckpoint({ chatId, productionId }: { chatId: string; productionId: string | null }) {
  /* The sample workspace spends nothing: no step is continued there, so no checkpoint is opened. */
  const spendOff = useSampleWorkspace();
  if (spendOff) return null;
  return (
    <ProjectProvider>
      <AtomikProvider>
        <Checkpoint chatId={chatId} productionId={productionId} />
      </AtomikProvider>
    </ProjectProvider>
  );
}

function Checkpoint({ chatId, productionId }: { chatId: string; productionId: string | null }) {
  const project = useProject();
  const a = useAtomik();
  const { selection, setSelection } = project;
  /* The plan is the production's: this one, so its thread is the one on screen. */
  useEffect(() => { if (productionId && selection !== productionId) setSelection(productionId); }, [selection, setSelection, productionId]);
  /* After the provider above is listening (its effects run after this one's). */
  useEffect(() => {
    const timer = setTimeout(() => openAtomikChat({ chatId, projectId: productionId }), 0);
    return () => clearTimeout(timer);
  }, [chatId, productionId]);
  if (a.chat?.id !== chatId) return <p className="cr-text" role="status" data-testid="approval-checkpoint-opening">Opening the plan…</p>;
  const checkpoint = a.current.kind === "checkpoint" ? a.current.step : null;
  if (!checkpoint) {
    return (
      <p className="cr-text" role="status" data-testid="approval-checkpoint-moved">
        {a.current.kind === "done" ? "Every step of this plan has run." : "This plan is not waiting for a step just now."}
      </p>
    );
  }
  return <Ready checkpoint={checkpoint} />;
}

/** The checkpoint, priced live: Continue at that price, or Stop here. Its own component, so the price's hover hook runs on every render. */
function Ready({ checkpoint }: { checkpoint: Step }) {
  const a = useAtomik();
  const credits = a.credits(checkpoint);
  const live = a.approvable(checkpoint) && credits !== null;
  /* Continue sends the live quote as its ceiling: "up to" where the quote is approximate, the figure where it is not. */
  const price = live ? (a.approximate(checkpoint) ? upTo(credits) : exact(credits)) : null;
  const dollars = usePriceTitle(price) ?? undefined;
  return (
    <div className="cr-checkpoint" role="group" aria-label="Checkpoint" data-testid="approval-checkpoint">
      <p className="cr-text">Next: {checkpoint.title} on {a.engineLabel(checkpoint.model)}. Continue approves this step at the price shown; nothing else runs.</p>
      <div className="cr-row-actions">
        <button type="button" className="cr-btn cr-btn--approve" disabled={!price || a.busy} aria-busy={a.busy || undefined} title={dollars} data-testid="approval-continue" {...spendAttrsOf(price)}
          onClick={() => void a.approve(checkpoint).finally(approvalsChanged)}>
          {a.busy ? "Starting…" : price ? <>Continue · <Price value={price} /></> : "Pricing…"}
        </button>
        <button type="button" className="cr-btn" disabled={a.busy} data-testid="approval-stop"
          onClick={() => void a.stop(checkpoint).finally(approvalsChanged)}>
          Stop here
        </button>
      </div>
      {a.stepQuoteError ? <p className="cr-row-error" role="alert">{a.stepQuoteError}</p> : null}
      {a.error ? <p className="cr-row-error" role="alert">{a.error}</p> : null}
    </div>
  );
}
