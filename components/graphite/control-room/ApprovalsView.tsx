"use client";
import { useCallback } from "react";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { openAtomikChat } from "@/lib/shell/use-skills";
import type { SettingsSectionId } from "@/lib/shell/settings";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { countLine, UNBILLED, type DecidedItem, type QueueItem } from "@/lib/control-room/queue";
import { LoadBanner } from "../TakeTile";
import { Price } from "../Price";
import { exact } from "@/lib/shell/price-words";
import { ApprovalRow } from "./ApprovalRow";
import { BatchApprove } from "./BatchApprove";
import { decidedLine, EMPTY_QUEUE } from "./words";

/**
 * Control room › Approvals (Atomik frame g; README § 3.4): one queue across
 * every project, the decisions of the last days, Approve in one go, and the
 * spending rules as they stand. Only a person approves, each item through its
 * own route at its own price (lib/control-room/approve.ts), and each person
 * approves their own spend: no admin approves another member's (owner, 21 Oct 2026).
 */
export function ApprovalsView() {
  const shell = useShell();
  const ws = useWorkspace();
  const queue = useApprovals();

  /* Settings' sections (lib/shell/settings.ts): the shell opens the section, or today's page for it while it has not landed. */
  const goSettings = useCallback((section: SettingsSectionId) => shell.goWorkspace(section), [shell]);
  const select = useCallback((draftId: string | null) => {
    if (draftId && draftId !== ws.state.projectId) ws.selectProject(draftId, { replace: true });
  }, [ws]);
  const open = useCallback((item: QueueItem) => {
    const to = item.open;
    if (to.kind === "take") { select(to.draftId); shell.openMake("recent"); return; }
    if (to.kind === "board") { select(to.draftId); shell.goSuite("studio", "rig"); return; }
    select(item.project.draftId);
    openAtomikChat({ chatId: to.chatId, projectId: to.productionId });
    shell.goSuite("atomik", "agent");
  }, [select, shell]);

  const reading = queue.status === "loading" && !queue.items.length;
  return (
    <div className="cr-body" data-testid="approvals">
      <section className="cr-col" aria-label="Waiting for you">
        {queue.error ? <LoadBanner banner={{ tone: queue.items.length ? "stale" : "error", message: queue.error }} onRetry={queue.refresh} testId="approvals-error" /> : null}
        <div className="cr-block">
          <div className="cr-block-head">
            <span className="cr-eyebrow">Waiting for you</span>
            {queue.items.length ? <span className="cr-count" data-testid="approvals-count">{countLine(queue.items)}</span> : null}
          </div>
          {reading ? <p className="cr-empty" role="status" aria-busy="true">Reading what waits…</p>
            : queue.items.length ? (
              <ul className="cr-list" aria-label="Waiting for you">
                {queue.items.map((item) => (
                  <ApprovalRow key={item.id} item={item} onApprove={queue.approve} onDecline={queue.decline} onOpen={open} onTopUp={() => goSettings("credits")} />
                ))}
              </ul>
            ) : queue.status === "ready" ? <p className="cr-empty" data-testid="approvals-empty">{EMPTY_QUEUE}</p> : null}
        </div>
        {queue.decided.length ? (
          <div className="cr-block" data-testid="approvals-decided">
            <span className="cr-eyebrow">Decided</span>
            <div>{queue.decided.map((item) => <DecidedRow key={item.id} item={item} />)}</div>
          </div>
        ) : null}
      </section>
      <section className="cr-col" aria-label="Rules and Approve in one go">
        <BatchApprove items={queue.items} run={queue.approveBatch} />
        <SpendWithoutAsking onEdit={() => goSettings("rules")} />
        <WhoMayApprove />
      </section>
    </div>
  );
}

function DecidedRow({ item }: { item: DecidedItem }) {
  const o = item.outcome;
  const tone = o.kind === "settled" ? "done" : o.kind === "settling" ? undefined : "quiet";
  return (
    <div className="cr-decided" data-testid="decided-row">
      <span className="cr-dot" data-tone={tone} aria-hidden="true" />
      <span className="cr-min">
        <span className="cr-decided-title">{item.title}</span>
        <span className="cr-decided-line">{decidedLine(item)}</span>
      </span>
      <span className="cr-figure" data-tone={o.kind === "settling" ? "settling" : o.kind === "settled" ? undefined : "quiet"}>
        {o.kind === "settled" ? <><Price value={exact(o.credits)} /> settled</>
          : o.kind === "settling" ? "not settled yet"
          : o.kind === "nothing" ? "nothing billed"
          : o.kind === "unbilled" ? UNBILLED
          : null}
      </span>
    </div>
  );
}

/** Spend without asking: never. Every paid step waits for a person's approval of its quote (owner, 20 Oct 2026: Auto goes), so there is no Ask/Auto choice to show. */
function SpendWithoutAsking({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="cr-block" data-testid="spend-without-asking">
      <span className="cr-eyebrow">Spend without asking</span>
      <div className="cr-seg-row">
        <span className="cr-strong" data-testid="spend-mode">Each paid step waits for a person.</span>
      </div>
      <button type="button" className="cr-link" onClick={onEdit} data-testid="spend-edit">Edit in Settings › Spending rules ›</button>
    </div>
  );
}

/** Who may approve: the person whose spend it is, on its price (owner, 21 Oct 2026: the admin approval rule is retired). Nothing to set. */
function WhoMayApprove() {
  return (
    <div className="cr-block" data-testid="who-may-approve">
      <span className="cr-eyebrow">Who may approve</span>
      <p className="cr-strong">Each person approves their own spend.</p>
    </div>
  );
}
