"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { importCopy, importParam, withoutImport, type ImportView } from "@/lib/workspace/rig-import";
import { useWorkspace } from "@/lib/workspace/state";
import { useRig } from "./RigProvider";
import "./rig.css";

/** Batches one import may take before it says where it stands (each is bounded on the server; Try again carries on). */
const MAX_BATCHES = 400;

/**
 * An old Rig board coming across onto this production's canvas (the Suites
 * URL's `import=<board>`, from "Open in the new Rig" on the old board). The
 * server brings it one bounded batch at a time; every open window sees the
 * cards arrive. The Rig says what is happening: while it runs, when it is
 * done, and when it stopped part way, with what came across and a free Try
 * again that carries on where it stopped.
 */
export function RigImport() {
  const rig = useRig();
  const { dispatch } = useWorkspace();
  const boardId = importParam(useSearchParams());
  const production = rig.project?.productionProjectId ?? null;
  const ready = !!boardId && !!production && rig.team.mode !== "off";
  const key = boardId && production ? `${production}:${boardId}` : null;
  const [run, setRun] = useState<{ key: string; view: ImportView } | null>(null);
  const view: ImportView | null = key && run?.key === key ? run.view : key ? { phase: "waiting" } : null;
  const busy = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const importBoard = rig.team.importBoard;

  const go = useCallback(async (runKey: string, board: string) => {
    if (busy.current === runKey) return;
    busy.current = runKey;
    const brought = { cards: 0, wires: 0 };
    let answer: Extract<ImportView, { phase: "running" }>["answer"] = null;
    const show = (next: ImportView) => { if (mounted.current) setRun({ key: runKey, view: next }); };
    show({ phase: "running", answer, brought: { ...brought } });
    try {
      let left = Infinity;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const got = await importBoard(board);
        if (!mounted.current) return;
        if (!got.ok) { show({ phase: "failed", answer, brought: { ...brought }, error: got.error, final: got.final }); return; }
        answer = got.answer;
        brought.cards += got.answer.brought.cards;
        brought.wires += got.answer.brought.wires;
        if (got.answer.done) { show({ phase: "done", answer: got.answer, brought: { ...brought } }); return; }
        show({ phase: "running", answer, brought: { ...brought } });
        /* No nearer the end (nothing came across, nothing less is left): it stopped here. Trying again carries on. */
        const now = got.answer.cards.left + got.answer.wires.left;
        if (now >= left && !got.answer.brought.cards && !got.answer.brought.wires) break;
        left = now;
      }
      show({ phase: "failed", answer, brought: { ...brought }, error: "It stopped before the end.", final: false });
    } finally {
      if (busy.current === runKey) busy.current = null;
    }
  }, [importBoard]);

  /* Once the canvas is open: the board comes across, onto the graph, where it can be seen arriving. */
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !key || !boardId || started.current === key) return;
    started.current = key;
    dispatch({ type: "patch", patch: { rigView: "graph" } });
    void go(key, boardId);
  }, [ready, key, boardId, go, dispatch]);

  const done = useCallback(() => {
    const next = withoutImport(window.location.pathname + window.location.search + window.location.hash);
    if (next) window.history.replaceState(window.history.state, "", next);
    setRun(null);
  }, []);

  if (!view || !key || !boardId) return null;
  const { line, notes } = importCopy(view);
  const retry = view.phase === "failed" && !view.final;
  const settled = view.phase === "done" || view.phase === "failed";
  return (
    <section className="pxw-import" data-testid="rig-import" data-phase={view.phase} aria-label="Old board" role={view.phase === "failed" ? "alert" : "status"} aria-live="polite">
      <span className="pxw-import-dot" aria-hidden="true" />
      <div className="pxw-import-text">
        <p className="pxw-import-line" data-testid="rig-import-line">{line}</p>
        {notes.map((note) => <p key={note} className="pxw-import-note">{note}</p>)}
      </div>
      {settled ? (
        <div className="pxw-import-actions">
          {retry ? <button type="button" className="pxw-btn pxw-btn--control" data-testid="rig-import-retry" aria-label="Try again, free" onClick={() => void go(key, boardId)}>Try again</button> : null}
          <button type="button" className="pxw-btn pxw-btn--control" data-testid="rig-import-done" onClick={done}>Done</button>
        </div>
      ) : null}
    </section>
  );
}
