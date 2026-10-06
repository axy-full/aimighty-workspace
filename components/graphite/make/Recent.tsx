"use client";
import { spendAttrs } from "@/lib/spend";
import { useMemo, useState } from "react";
import Boundary from "@/components/Boundary";
import { VirtualItems } from "@/components/workspace/VirtualItems";
import { SAY, referenceRole } from "@/lib/shell/assets";
import { RECENT_CHIPS, recentEntries, type RecentChip } from "@/lib/shell/make";
import { exact } from "@/lib/shell/price-words";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import type { Project } from "@/lib/workbench/studio";
import { libraryView, type LibraryEntry, type ProjectLibrary } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { TileFault } from "../PanelFault";
import { Price } from "../Price";
import { LoadBanner, TakeSkeletons, TakeTile } from "../TakeTile";
import type { MakeModel } from "./use-make";

/* The same solid ring the shell draws for a run with no reported progress: none is invented. */
const RING: Record<string, string> = { blue: "var(--gx-accent)", amber: "var(--gx-waiting)", red: "var(--gx-failed)", green: "var(--gx-done)", idle: "var(--gx-idle)" };

/**
 * Make › Recent ("Make frames.dc.html" 4; README § 7: the takes wall is Make's Recent): the open project's takes and
 * uploads, newest first, under All · Takes · Unfiled · Filed, one card a row. Each card is the take's own (TakeTile:
 * its state, a held take's Release, what a failed take was charged) with Again, which puts its recipe back in Make
 * to be priced again (Retry, for a failed one), and Use as reference. Nothing here runs or charges anything.
 */
export function Recent({ project, items, library, projects, make }: {
  project: Project | null; items: LibraryEntry[]; library: ProjectLibrary; projects: "loading" | "ready" | "error"; make: MakeModel;
}) {
  const shell = useShell();
  const ws = useWorkspace();
  const recreate = useRecreate();
  const [chip, setChip] = useState<RecentChip>("All");
  const shown = useMemo(() => recentEntries(items, chip), [items, chip]);
  const view = libraryView(project ? library.state : null, items.length ? 1 : 0, projects);
  /* The take Make just sent, until the Library carries it. */
  const running = ws.state.gen && !ws.state.gen.id.startsWith("batch:") && !items.some((entry) => entry.take.sourceId === ws.state.gen?.id) ? ws.state.gen : null;
  const open = (entry: LibraryEntry) => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); };
  const reference = (entry: LibraryEntry) => {
    const role = referenceRole(entry.media);
    if (!role) { ws.toast("References are images and videos."); return; }
    sendReference({ id: entry.take.id, name: entry.take.name });
    shell.setMake(make.state.type);
    ws.toast(SAY.referenced(entry.take.name, role));
  };

  const card = (entry: LibraryEntry) => {
    const generated = entry.take.kind === "GEN";
    const settled = entry.take.credits;
    const referable = entry.media === "image" || entry.media === "video";
    return (
      <article className="gx-mk-card" data-testid="make-recent-card" data-take={entry.take.id} data-status={entry.take.status}>
        <Boundary what="This take" probe={`take:${entry.take.id}`} resetKey={entry.take.id} fallback={(fault) => <TileFault fault={fault} name={entry.take.name} />}>
          <TakeTile entry={entry} variant="grid" selected={ws.state.selKind === "take" && ws.state.selId === entry.take.id} onRefresh={library.refresh} onOpen={() => open(entry)}
            meta={<>{entry.take.meta}{settled != null && settled > 0 ? <> · <Price value={exact(settled)} /></> : null}</>} />
        </Boundary>
        {generated || referable ? (
          <div className="gx-mk-card-actions">
            {generated ? <button type="button" className="gx-hbtn" onClick={() => recreate(entry)} data-testid="make-again">{entry.take.status === "failed" ? "Retry" : "Again"}</button> : null}
            {referable ? <button type="button" className="gx-hbtn" onClick={() => reference(entry)} data-testid="make-use-reference">Use as reference</button> : null}
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <section className="gx-mk-recent" aria-label="Recent">
      <div className="gx-mk-chips" role="group" aria-label="Show">
        {RECENT_CHIPS.map((c) => <button key={c} type="button" className="gx-chip" aria-pressed={chip === c} onClick={() => setChip(c)} data-testid={`make-recent-${c.toLowerCase()}`}>{c}</button>)}
      </div>
      {view.banner ? <LoadBanner banner={view.banner} onRetry={library.refresh} testId="gen-results-error" /> : null}
      <Boundary what="Recent" probe="make-recent" resetKey={`${chip}:${project?.id ?? ""}`} fallback={(fault) => <TileFault fault={fault} name="Recent" />}>
        <VirtualItems className="gx-mk-cards" items={shown} getKey={(entry: LibraryEntry) => entry.take.id} layout={{ columns: 1 }} gap={12} estimateRowHeight={330} scroll="ancestor"
          attrs={{ "data-testid": "make-recent-list" }}
          before={<>
            {running ? (
              <article className="gx-mk-card" data-testid="gen-running">
                <div className="gx-asset gx-tile" data-face="live">
                  <div className="gx-tile-media">
                    <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: RING[running.tone ?? "blue"] }} aria-hidden="true" /></span>
                    <span className="gx-tile-chip" data-tone={running.tone === "red" ? "failed" : running.tone === "green" ? "done" : "live"}><span className="gx-tile-chip-dot" aria-hidden="true" />{running.label ?? "Rendering"}</span>
                  </div>
                  <span className="gx-asset-name">{running.name ?? "Rendering"}</span>
                  <span className="gx-asset-meta">{running.meta || running.label || "Running"}</span>
                </div>
              </article>
            ) : null}
            {view.skeletons ? <TakeSkeletons count={3} variant="grid" /> : null}
          </>}
          renderItem={(entry: LibraryEntry) => card(entry)} />
      </Boundary>
      {!running && !shown.length && !view.skeletons && !view.banner ? (
        <div className="gx-mk-empty" data-testid="gen-results-empty">
          <p>{items.length ? `Nothing ${chip === "Filed" ? "filed on a shot" : chip === "Unfiled" ? "unfiled" : "made"} here yet.` : "Nothing made in this project yet."}</p>
          <button type="button" className="gx-hbtn" onClick={() => shell.setMake(make.state.type)} data-testid="make-recent-make" {...spendAttrs("free")}>Make something</button>
        </div>
      ) : null}
    </section>
  );
}
