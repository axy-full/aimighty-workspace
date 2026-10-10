"use client";
import { useCallback, useMemo, useState } from "react";
import { recreatePreset } from "@/lib/shell/recipe";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import { sendReference } from "@/lib/shell/reference-inbox";
import { useSession } from "@/lib/session";
import type { Project } from "@/lib/workbench/studio";
import { modeFromParam, type MakeMode, type ResultTile } from "@/lib/v12/make";
import { useToast } from "@/components/v12/ui/Toast";
import { usePlaces } from "@/components/graphite/atomik/panel/use-places";
import { Composer } from "./Composer";
import { Results } from "./Results";
import { Viewer } from "./Viewer";
import { useResults, useTrayPrices } from "./use-results";
import "./make.css";

export type V12MakeProps = {
  scope: string;
  project: Project | null;
  projects: "loading" | "ready" | "error";
  projectsError: string | null;
  onRetry: () => void;
  workspaceName: string | null;
  onProject: (id: string) => void;
  balance: number | null;
};

/** What the address asked for when the page opened: `mk=` (a mode) and `viewer=1` (the viewer on the newest result). */
function asked(): { mode: MakeMode | null; viewer: boolean } {
  if (typeof window === "undefined") return { mode: null, viewer: false };
  const q = new URLSearchParams(window.location.search);
  return { mode: modeFromParam(q.get("mk")), viewer: q.get("viewer") === "1" };
}

/**
 * Make as a page of the new interface (redesign plan C3; docs/redesign/inventory.md § 5.12): the workspace's results in
 * justified rows, the viewer, and the docked composer. Opened by today's Make addresses (`make=…`, `?view=make`) with the
 * switch on at desktop sizes, in place of the Make panel. Its composer (Composer.tsx) is today's Make (use-make.ts) drawn
 * on the shared bar: the same quote and the same one priced send, marked where it is pressed. A press that went through keeps the page open; the take shows up
 * in the results, rendering.
 */
export function V12Make({ scope, project, projects, projectsError, onRetry, workspaceName, onProject, balance }: V12MakeProps) {
  const results = useResults(scope);
  const trayPrices = useTrayPrices();
  const session = useSession();
  const toast = useToast();
  const places = usePlaces();
  const paysInDollars = session.rates.unit === "usd";
  const [first] = useState(asked);

  /* Selection, and the viewer over the finished takes. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const select = (id: string) => setSelected((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const viewable = useMemo(() => results.tiles.filter((t) => t.source.status === "succeeded" && t.url), [results.tiles]);
  /* `viewer=1` opens the viewer on the newest result once there is one. */
  const [viewingAt, setViewing] = useState<number | null | "first">(first.viewer ? "first" : null);
  const viewing = viewingAt === "first" ? (viewable.length ? 0 : null) : viewingAt;
  const open = (tile: ResultTile) => { const i = viewable.findIndex((t) => t.id === tile.id); if (i >= 0) setViewing(i); };

  /* Prompt reuse: the take's words and settings land in the composer itself (lib/shell/recipe recreatePreset, read by
     use-make's preset inbox), and a take used as a reference arrives through the reference inbox it reads too. */
  const [seed, setSeed] = useState<{ value: number; model: string } | null>(null);
  const reuse = useCallback((tile: ResultTile) => {
    if (tile.reuseBlock) return;
    setViewing(null);
    setSeed(null);
    sendGenPreset(recreatePreset(tile.source, { name: tile.prompt.slice(0, 60) }));
    toast({ text: "Prompt and settings loaded into the composer" });
  }, [toast]);
  const reference = useCallback((tile: ResultTile) => {
    sendReference({ id: `generation:${tile.id}`, name: tile.prompt.slice(0, 60) });
    setViewing(null);
    toast({ text: "Added to the composer's references" });
  }, [toast]);
  /* Reuse seed: the take's words and settings, as Variations, and its seed, sent with the next clip while its engine is picked. */
  const reuseSeed = useCallback((tile: ResultTile, value: number) => {
    if (tile.reuseBlock) return;
    setViewing(null);
    sendGenPreset(recreatePreset(tile.source, { name: tile.prompt.slice(0, 60) }));
    setSeed({ value, model: tile.model });
    toast({ text: `Seed ${value} set · the next make repeats it` });
  }, [toast]);
  const input = useMemo(() => ({ scope, project, projects, workspaceName, onProject, balance, seed }), [scope, project, projects, workspaceName, onProject, balance, seed]);

  return (
    <div className="v12-mk" data-testid="v12-make" data-v12-make="" data-screen-label="Make">
      <div className="v12-mk-scroll gx-scroll">
        {projectsError ? (
          <p className="v12-mk-problem" role="alert">{projectsError} <button type="button" className="v12-mk-link" onClick={onRetry}>Try again</button></p>
        ) : null}
        <Results tiles={results.tiles} status={results.status} typical={results.typical} trayPrices={trayPrices} paysInDollars={paysInDollars}
          selected={selected} onSelect={select} onOpen={open} onReuse={reuse} />
      </div>
      <div className="v12-mk-band">
        {/* The Library (the prototype's tray over Make is redesign C4; until it lands, the board's Library drawer, as ⌘K's "Library" opens it). */}
        <button type="button" className="v12-mk-library" onClick={places.library} title="Library · L — Your characters, locations, products and everything made." data-testid="v12-make-library">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></svg>
          Library
        </button>
        <Composer input={input} asked={first.mode} mentions={results.tiles} onClearSeed={() => setSeed(null)} />
      </div>
      <Viewer tiles={viewable} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} onReuse={reuse} onReuseSeed={reuseSeed} onReference={reference} paysInDollars={paysInDollars} />
    </div>
  );
}
