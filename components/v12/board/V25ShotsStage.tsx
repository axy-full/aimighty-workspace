"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { shotTakes } from "@/components/graphite/board/cards/take/take-model";
import type { LibraryEntry } from "@/lib/workspace/library";
import { withCardOverride, withStepSetting, type BoardMode, type SettingValue } from "@/lib/v12/board/board-data";
import type { Stage } from "@/lib/v12/board/stages";
import { DirectorBar } from "./DirectorBar";
import { DirectorColumn } from "./DirectorColumn";
import { ShotPreview } from "./ShotPreview";
import { ShotStepCard } from "./ShotStepCard";
import { SHOTS_SETTINGS, SHOTS_STEP, cardChips, scopeOf, shotSettings } from "./director-model";
import { directorShots } from "./director-shots";
import "./v25-shots.css";

/**
 * The Shots step on a v25 board (v25 PR 7, wired): the shots as v25 cards in a real layout grid (real sizes, no zoom: text and borders are drawn at their own size
 * at every window), the preview over them on a double-click or Space, and in Director mode the settings column at the right and the bar at the bottom.
 * It is drawn over the stage's canvas, as the Deliver and PPM pages are, once the board has shots; before then the stage keeps its own empty state.
 *
 * Agent mode names no engine anywhere on this screen (owner, 16 Oct 2026): a card says its status and nothing about what made it. The board's own ask bar stays
 * as it is (BoardView draws it); here is only the grid and the preview. Director mode keeps what Director shows: the column, whose model line is "Auto".
 * Selection is the board's own (`ctx.selection`), so the header's crumb, Esc and the ask bar's chip all say the same.
 */
export function V25ShotsStage({ ctx, library, mode, stages, ask, onNext }: {
  ctx: BoardCtx;
  library: readonly LibraryEntry[];
  mode: BoardMode;
  stages: readonly Pick<Stage, "id" | "label" | "skipped">[];
  /** The board's own ask bar (Attach, @, words, Ask): Director mode docks it inside its bar beside the one spend button. */
  ask: ReactNode;
  /** After "Next: …": the board opens that stage. */
  onNext: (id: string) => void;
}) {
  const rows = useMemo(() => shotTakes(ctx.project, library), [ctx.project, library]);
  const director = mode === "director";
  const [openId, setOpenId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [sent, setSent] = useState<{ state: string; finished: number; total: number }>({ state: "idle", finished: 0, total: 0 });
  const dock = useRef<HTMLDivElement>(null);
  /* The bar's height (it grows with a note or a selection chip), so the preview leaves it in reach. */
  const [dockHeight, setDockHeight] = useState(96);
  useEffect(() => {
    const el = dock.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setDockHeight(Math.ceil(el.getBoundingClientRect().height));
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [mode]);
  const selected = rows.filter((r) => ctx.selection.ids.has(r.nodeId)).map((r) => r.nodeId);
  const scope = scopeOf(selected, rows.map((r) => ({ id: r.nodeId, name: `Shot ${r.index}` })));
  const { shots, left } = useMemo(() => (director ? directorShots(ctx.project, ctx.rig.shots, scope.ids) : { shots: [], left: 0 }), [director, ctx.project, ctx.rig.shots, scope.ids]);

  const values = shotSettings(ctx.project, scope.all ? null : scope.ids[0]);
  const mixed = new Set<string>();
  if (!scope.all && scope.ids.length > 1) for (const item of SHOTS_SETTINGS) if (new Set(scope.ids.map((id) => shotSettings(ctx.project, id)[item.id])).size > 1) mixed.add(item.id);
  const setSetting = (id: string, value: SettingValue) => {
    const refusal = ctx.rig.apply((p) => {
      if (scope.all) return { ...p, boardSetup: withStepSetting(p.boardSetup, "director", SHOTS_STEP, id, value) };
      const step = shotSettings({ boardSetup: p.boardSetup }, null)[id];
      let overrides = p.boardOverrides;
      for (const card of scope.ids) overrides = withCardOverride(overrides, card, id, value === step ? null : value);
      return { ...p, boardOverrides: overrides };
    });
    if (refusal) ctx.toast(refusal);
  };
  const differs = (card: string) => hover !== null && cardChips(ctx.project, card).some((c) => c.id === hover);
  const readOnly = ctx.offline ? "Offline · changes queue" : ctx.readOnly ?? ctx.exploreOnly ?? null;
  const note = left > 0 ? `${left} ${left === 1 ? "shot is" : "shots are"} not ready to price yet (its brief or a reference is still being saved).` : null;
  /* The preview leaves the column and the bar in reach (Director mode), as the prototype does. */
  const inset = director ? { right: 252, bottom: dockHeight + 20 } : undefined;

  return (
    <div className="v25-shots" data-testid="v25-shots-stage" data-mode={mode} data-state={sent.state}>
      <div className="v25-shots-grid" data-testid="v25-shots-grid">
        {rows.map((row) => {
          return (
            <ShotStepCard key={row.nodeId} row={row} scope={ctx.scope} projectId={ctx.project.id} selected={ctx.selection.ids.has(row.nodeId)}
              dimmed={director && hover !== null && !differs(row.nodeId)} differs={director && differs(row.nodeId)} chips={director ? cardChips(ctx.project, row.nodeId) : undefined}
              onOpen={() => setOpenId(row.nodeId)}
              onSelect={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey) ctx.select(row.nodeId, { add: true });
                else if (selected.length === 1 && selected[0] === row.nodeId) ctx.select(null);
                else ctx.select(row.nodeId);
              }} />
          );
        })}
      </div>
      {director ? (
        <>
          <div className="v25-shots-col"><DirectorColumn scope={scope} step="Shots" values={values} mixed={mixed} onSet={setSetting} onHover={setHover} /></div>
          <div className="v25-shots-dock" ref={dock}>
            <DirectorBar scope={scope} scopeKey={ctx.scope} projectKey={ctx.project.id} shots={shots} stages={stages} step={SHOTS_STEP} readOnly={readOnly ?? (shots.length ? null : note ?? "No shot can be priced yet.")}
              ask={ask} onState={(s) => setSent((now) => (now.state === s.state && now.finished === s.finished && now.total === s.total ? now : s))}
              onNext={(next) => { if (next) onNext(next.id); }} />
          </div>
        </>
      ) : null}
      {openId ? (
        <ShotPreview rows={rows} scope={ctx.scope} projectId={ctx.project.id} openId={openId} onStep={setOpenId} onClose={() => setOpenId(null)} inset={inset}
          note={director ? "The column and the bar act on this shot." : undefined} />
      ) : null}
    </div>
  );
}
