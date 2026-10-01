"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { importBatch, importCopy, importedBoardOf, importParam, withoutImport, type ImportView } from "@/lib/workspace/rig-import";
import { useWorkspace } from "@/lib/workspace/state";
import { useRig } from "./RigProvider";
import "./rig.css";

/** Batches one import may take before it says where it stands (each is bounded on the server; Try again carries on). */
const MAX_BATCHES = 400;
/** How long "done" waits for the cards to reach this window (the live room, or its few-seconds check of the canvas). */
const ARRIVAL_MS = 15_000;

/**
 * An old Rig board coming across onto this production's canvas (the Suites
 * URL's `import=<board>`, from "Open in the new Rig" on the old board). The
 * server brings it one bounded batch at a time; every open window sees the
 * cards arrive (this one folds each batch in as it lands; others through the
 * live room, or their few-seconds check of the canvas). The Rig says what is
 * happening: while it runs, when it is done, and when it stopped part way,
 * with what came across and a free Try again that carries on where it stopped.
 */
export function RigImport() {
  const rig = useRig();
  const { dispatch } = useWorkspace();
  const boardId = importParam(useSearchParams());
  /* The draft's production: its team canvas is where the board comes across. Nothing waits for this window to have
     opened that canvas: the cards reach it either way (read with it, or folded in by the live room or the check). */
  const production = rig.project?.productionProjectId ?? null;
  const key = boardId && production ? `${production}:${boardId}` : null;
  const [run, setRun] = useState<{ key: string; view: ImportView } | null>(null);
  const view: ImportView | null = key && run?.key === key ? run.view : key ? { phase: "waiting" } : null;
  const busy = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scope = rig.scope;
  const importBoard = useCallback((board: string) => importBatch({ scope, boardId: board, productionId: production ?? "" }), [scope, production]);
  /* Folds what the server just changed into this window now, not at its next check (a live room brings it by itself). */
  const { refresh } = rig.team;
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

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
        /* The cards this batch brought appear here as it lands (teammates' windows: the live room, or their own check). */
        if (got.answer.brought.cards || got.answer.brought.wires) {
          await refreshRef.current().catch(() => undefined);
          if (!mounted.current) return;
        }
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

  /* Once the draft is open: the board comes across, onto the graph, where it can be seen arriving. */
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!key || !boardId || started.current === key) return;
    started.current = key;
    dispatch({ type: "patch", patch: { rigView: "graph" } });
    void go(key, boardId);
  }, [key, boardId, go, dispatch]);

  /* Done: the line goes, and so does the board from the address. Coming back to that address (Back) asks again: free,
     and it says what it finds rather than a line that never ends. */
  const done = useCallback(() => {
    const next = withoutImport(window.location.pathname + window.location.search + window.location.hash);
    /* A state of its own (null), as the shell's writes do: Next.js syncs useSearchParams only for those. */
    if (next) window.history.replaceState(null, "", next);
    started.current = null;
    setRun(null);
  }, []);

  /* "Done" once the cards that came across are on this window's canvas too, or after a moment in any case. */
  const shown = useMemo(() => (boardId ? (rig.project?.nodes ?? []).filter((node) => importedBoardOf(node) === boardId).length : 0), [rig.project, boardId]);
  const [waited, setWaited] = useState<ImportView | null>(null);
  const finished = view?.phase === "done" ? view : null;
  const arriving = !!finished && finished.brought.cards > 0 && shown < finished.answer.cards.here && waited !== finished;
  useEffect(() => {
    if (!arriving || !finished) return;
    const timer = setTimeout(() => setWaited(finished), ARRIVAL_MS);
    return () => clearTimeout(timer);
  }, [arriving, finished]);

  if (!view || !key || !boardId) return null;
  const said: ImportView = arriving && finished ? { phase: "running", answer: finished.answer, brought: finished.brought } : view;
  const { line, notes } = importCopy(said);
  const retry = said.phase === "failed" && !said.final;
  const settled = said.phase === "done" || said.phase === "failed";
  return (
    <section className="pxw-import" data-testid="rig-import" data-phase={said.phase} aria-label="Old board" role={said.phase === "failed" ? "alert" : "status"} aria-live="polite">
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
