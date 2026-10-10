"use client";
import { useRef, useState } from "react";
import { useShell } from "@/lib/shell/state";
import { useWorkspace } from "@/lib/workspace/state";
import { useJobsTray } from "@/lib/shell/use-jobs-tray";
import { openAtomikChat } from "@/lib/shell/use-skills";
import { priceLabel, type TrayJob } from "@/lib/jobsTray";
import type { ApprovalsState } from "@/lib/control-room/use-approvals";
import type { QueueItem } from "@/lib/control-room/queue";
import { Price } from "@/components/graphite/Price";
import { Popover, Segment, Tooltip } from "../ui";
import { activityGroups, activityLabel, activityTone, heldPrice, type ActivityScope, type LookRow, type NeedsRow, type RunningRow } from "./activity";

/**
 * The Activity pill and its dropdown (docs/redesign/inventory.md § 5.4; prototype L51, L75): what needs you and what is
 * running, across all boards or this one. Needs you is the approvals queue; Running is the jobs tray. A row's name opens
 * it at its board and card. Approving stays where the item is (its card, Home's Waiting for you): the header only takes
 * you there, so no new way to spend is added here.
 */
export function ActivityPill({ approvals, draftId, onBoard }: { approvals: ApprovalsState; draftId: string | null; onBoard: (id: string) => void }) {
  const shell = useShell();
  const ws = useWorkspace();
  const tray = useJobsTray();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setScope] = useState<ActivityScope>("all");
  /* "This board" only while a board is open: off a board the list is every board's again. */
  const scope: ActivityScope = draftId ? chosen : "all";
  /* `?activity=1` opens it on landing, as the prototype's address does. Read from the address the page loaded with: the
     shell rewrites the address to its own params before the header draws. */
  const [landed, setLanded] = useState(landedWithActivity);
  const shown = open || landed;
  const close = () => { setOpen(false); setLanded(false); };

  const now = tray?.now ?? 0;
  const heldWord = (job: TrayJob) => heldPrice(job, (price) => priceLabel(price));
  const all = activityGroups(tray?.jobs ?? [], approvals.items, { scope: "all", draftId, now, heldWord });
  const groups = scope === "all" ? all : activityGroups(tray?.jobs ?? [], approvals.items, { scope, draftId, now, heldWord });
  const label = activityLabel(all.needs.length, all.running.length);
  const tone = activityTone(all.needs.length, all.running.length);

  const select = (id: string | null) => { if (id && id !== ws.state.projectId) ws.selectProject(id, { replace: true }); };
  /* Today's places for each kind of item (components/graphite/control-room/ApprovalsView.tsx › open), on the board. */
  const openNeeds = (item: QueueItem) => {
    close();
    const to = item.open;
    if (to.kind === "take") { select(to.draftId); shell.openMake("recent"); return; }
    if (to.kind === "board") { if (to.draftId) onBoard(to.draftId); else shell.goBoard({ closeMake: true }); return; }
    select(item.project.draftId);
    openAtomikChat({ chatId: to.chatId, projectId: to.productionId });
    shell.openAtomik("panel");
  };
  const openRunning = (job: TrayJob) => {
    close();
    if (!job.draftId) { shell.openMake("recent"); return; }
    select(job.draftId);
    if (job.takeId) shell.selectAsset(job.takeId, { reason: "pick" });
    shell.goBoard({ region: "shots", closeMake: true });
  };

  return (
    <>
      <Tooltip name="Activity" line="What needs you and what’s running, across all boards.">
        <button ref={anchor} type="button" className="v12-activity" data-tone={tone} aria-haspopup="dialog" aria-expanded={shown}
          onClick={() => { if (shown) close(); else setOpen(true); }} data-testid="v12-activity">
          <span className="v12-activity-dot" aria-hidden="true" />
          {label}
        </button>
      </Tooltip>
      <Popover open={shown} onClose={close} anchor={anchor} label="Activity" width={400} align="end" testId="v12-activity-menu" autoFocus={!landed}>
        <div className="v12-act-head">
          <Segment label="Which boards" size="sm" value={scope} onChange={setScope}
            options={[{ id: "all", label: "All boards" }, { id: "board", label: "This board", disabled: !draftId }]} />
          <span>{label}</span>
        </div>
        {groups.needs.length ? <Group title="Needs you" rows={groups.needs} onOpen={(row) => openNeeds((row as NeedsRow).item)} /> : null}
        {groups.running.length ? <Group title="Running" rows={groups.running} onOpen={(row) => openRunning((row as RunningRow).job)} /> : null}
        {groups.look.length ? <Group title="Needs a look" rows={groups.look} onOpen={(row) => openRunning((row as LookRow).job)} /> : null}
        {!groups.needs.length && !groups.running.length && !groups.look.length ? (
          <p className="v12-act-empty" data-testid="v12-activity-empty">{scope === "board" ? "Nothing waits or runs on this board." : "Nothing waits for you and nothing is running."}</p>
        ) : null}
      </Popover>
    </>
  );
}

function landedWithActivity(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return new URL(entry?.name ?? window.location.href).searchParams.get("activity") === "1";
  } catch {
    return false;
  }
}

function Group({ title, rows, onOpen }: { title: string; rows: readonly (NeedsRow | RunningRow | LookRow)[]; onOpen: (row: NeedsRow | RunningRow | LookRow) => void }) {
  return (
    <div role="group" aria-label={title}>
      <div className="v12-act-group">{title}</div>
      {rows.map((row) => (
        <div key={row.id} className="v12-act-row" data-kind={row.kind} data-testid="v12-activity-row">
          <span className="v12-act-dot" data-kind={row.kind} aria-hidden="true" />
          <Tooltip name="Open at the exact stage and card">
            <button type="button" className="v12-act-main" onClick={() => onOpen(row)}>
              <span className="v12-act-name">{row.name}</span>
              <span className="v12-act-meta">
                {row.meta}
                {row.kind === "needs" && row.item.price ? <> · <Price value={row.item.price} /></> : null}
              </span>
            </button>
          </Tooltip>
          <button type="button" className="v12-act-btn" data-kind={row.kind} onClick={() => onOpen(row)} data-testid="v12-activity-act">
            {row.kind === "needs" ? "Review" : "Open card"}
          </button>
        </div>
      ))}
    </div>
  );
}
