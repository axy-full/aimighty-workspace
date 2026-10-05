"use client";
import { useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { RUN_FILTERS, type RunFilter } from "@/lib/control-room/activity";
import { ApprovalsView } from "./ApprovalsView";
import { ActivityView } from "./ActivityView";
import { controlRoomPage, type ControlRoomPageId } from "./pages";
import "./control-room.css";

/**
 * Atomik's control room (design/particl-graphite/README.md § 1.1, § 3.4;
 * Atomik frames g–j): the entry the shell mounts for `?suite=atomik&page=<id>`
 * when the new interface is on, with the shell's open project. Its own head
 * row (title, hint, and Activity's filter, as the frames have them); the shell
 * keeps the header, the page strip and the project.
 *
 * Approvals (PR 8.1) and Activity (PR 8.2) are here. Skills and Memory follow;
 * until each lands the shell keeps showing today's page for it.
 */
export function ControlRoom({ page, project = null }: { page: ControlRoomPageId; project?: Project | null }) {
  const def = controlRoomPage(page);
  const [filter, setFilter] = useState<RunFilter>("All");
  return (
    <div className="cr" data-testid="control-room" data-page={page}>
      <header className="cr-head" data-row="page">
        <h1 className="cr-h1" data-testid="page-title">{def.title}</h1>
        <span className="cr-hint">{def.hint}</span>
        {page === "runs" ? (
          <div className="cr-seg cr-head-seg" role="group" aria-label="Show runs" data-testid="runs-filter">
            {RUN_FILTERS.map((f) => (
              <button key={f} type="button" className="cr-seg-btn" aria-current={filter === f ? "true" : undefined} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        ) : null}
      </header>
      {page === "approvals" ? <ApprovalsView /> : null}
      {page === "runs" ? <ActivityView project={project} filter={filter} /> : null}
    </div>
  );
}
