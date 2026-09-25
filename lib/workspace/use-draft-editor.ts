"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { merge3, rebaseDraft, sameJson } from "@/lib/workbench/merge";
import {
  DraftRequestError,
  draftRequest,
  writeMergedDraft,
} from "@/lib/workbench/draft-request";

/**
 * An editable copy of one project draft for a workspace page that mounts a
 * Studio panel (Brief & Script, Boards, Astra 3D).
 *
 * It is the pattern the suites already use (AtomikGenerate, SubatomikWorkspace):
 * read the draft and its revision from GET /api/workbench/projects, write it
 * back through lib/workbench/draft-request — revision-checked, so it never
 * writes over another window's newer revision. Edits are saved 650ms after the
 * last change, like Studio.
 *
 * The editor keeps the draft as the server last held it (`base`) beside the
 * edited copy. When another save landed first (the Rig, another stage, another
 * tab), the edits made since `base` are merged into the newer version
 * (lib/workbench/merge.ts) and saved at its revision, and the page then shows
 * the merged draft: nothing either side added or changed is lost. A save whose
 * outcome is unknown is kept and tried again, reconciled the same way. Any
 * other rejected save stops further saves and keeps the edits on screen;
 * `reload` discards them for the saved version.
 */

export type DraftEditor = {
  status: "loading" | "ready" | "error";
  project: Project | null;
  /** "Saved", "Saving", "Not saved" — or the load error. */
  saveState: string;
  error: string;
  change: (fn: (previous: Project) => Project) => void;
  /** Flush pending edits; true once the current project is saved. */
  ensureSaved: () => Promise<boolean>;
  /** Save pending edits, then read the saved draft again (e.g. after a render registered outputs). */
  refresh: () => Promise<Project | null>;
  /** Drop local edits and read the saved version. */
  reload: () => void;
};

const API = "/api/workbench";
const SAVE_DELAY_MS = 650;
/** A save whose outcome is unknown (the connection dropped) is tried again after this, then less often. */
const RETRY_MS = 4000;
const RETRY_MAX_MS = 60_000;

type Loaded = { project: Project | null; revision: number };

/** True when the edited draft is exactly what the server holds. */
const settled = (edited: Project | null, saved: Project | null) => !edited || sameJson(edited, saved);

export function useDraftEditor(scope: string | null, projectId: string | null): DraftEditor {
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<DraftEditor["status"]>("loading");
  const [saveState, setSaveState] = useState("Loading");
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);

  /** The edited draft. */
  const current = useRef<Project | null>(null);
  /** The draft exactly as the server holds it at `revision`: what the edits are merged from. */
  const base = useRef<Project | null>(null);
  const revision = useRef(0);
  const failed = useRef(false);
  const retries = useRef(0);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    async (id: string) => draftRequest<Loaded>(`${API}/projects?id=${encodeURIComponent(id)}`, scope ?? ""),
    [scope],
  );

  useEffect(() => {
    if (!scope || !projectId) return;
    let active = true;
    read(projectId)
      .then((data) => {
        if (!active) return;
        current.current = data.project;
        base.current = data.project;
        revision.current = data.revision;
        failed.current = false;
        retries.current = 0;
        setProject(data.project);
        setStatus(data.project ? "ready" : "error");
        setSaveState(data.project ? "Saved" : "Not found");
        setError(data.project ? "" : "This project could not be opened.");
      })
      .catch((problem: unknown) => {
        if (!active) return;
        setStatus("error");
        setError(problem instanceof Error ? problem.message : "This project could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [scope, projectId, read, epoch]);

  /** Saves the edited draft; true once the write succeeded (edits made meanwhile are saved by the next flush). */
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.catch(() => false).then(async () => {
      const snapshot = current.current, from = base.current;
      if (!snapshot || !from || !scope) return false;
      if (failed.current) return false;
      if (sameJson(snapshot, from)) return true;
      if (alive.current) setSaveState("Saving");
      try {
        const saved = await writeMergedDraft(API, scope, { base: from, mine: snapshot, revision: revision.current });
        /* Another project opened meanwhile: its own draft stands. */
        if (current.current?.id !== snapshot.id) return true;
        retries.current = 0;
        revision.current = saved.revision;
        base.current = saved.project;
        /* The page shows what was saved — another window's edits included — with any edits made meanwhile laid over it. */
        const next = rebaseDraft(snapshot, current.current, saved.project);
        current.current = next;
        if (alive.current) {
          setProject(next);
          setSaveState(settled(next, saved.project) ? "Saved" : "Saving");
          setError("");
        }
        return true;
      } catch (problem) {
        const message = problem instanceof Error ? problem.message : "Save failed. Your current work is preserved.";
        if (problem instanceof DraftRequestError && (problem.uncertain || problem.retryable)) {
          /* Unknown or temporary: the edits stay, and the same save is tried again (merged, so never applied twice). */
          if (alive.current) {
            setSaveState(problem.uncertain ? "Save unconfirmed" : "Not saved");
            setError(message);
            const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retries.current++);
            if (!timer.current) timer.current = setTimeout(() => retry.current(), wait);
          }
          return false;
        }
        failed.current = true;
        if (alive.current) {
          setSaveState("Not saved");
          setError(message);
        }
        return false;
      }
    });
    return chain.current;
  }, [scope]);
  useEffect(() => { retry.current = () => void flush(); }, [flush]);

  const change = useCallback(
    (fn: (previous: Project) => Project) => {
      const previous = current.current;
      if (!previous) return;
      const next = fn(previous);
      if (next === previous) return;
      current.current = next;
      setProject(next);
      if (failed.current) return;
      setSaveState("Saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  const ensureSaved = useCallback(async () => {
    /* Edits made during the write are saved by the next flush. */
    for (let pass = 0; pass < 3; pass++) {
      if (!(await flush())) return false;
      if (settled(current.current, base.current)) return true;
    }
    return settled(current.current, base.current);
  }, [flush]);

  const refresh = useCallback(async () => {
    const id = current.current?.id;
    if (!id) return null;
    if (!(await ensureSaved())) throw new Error("Save this project before loading its saved outputs.");
    /* Read in turn with the saves, so a save cannot land between the read and its use. */
    const step = chain.current.catch(() => false).then(async (): Promise<Project | null> => {
      const data = await read(id);
      if (!data.project || current.current?.id !== id) return null;
      const edited = current.current, from = base.current;
      /* Edits made while it was read stay on screen, laid over the saved draft. */
      const next = edited && from ? merge3(from, edited, data.project) : data.project;
      revision.current = data.revision;
      base.current = data.project;
      current.current = next;
      if (alive.current) setProject(next);
      return next;
    });
    chain.current = step.then((next) => next !== null, () => false);
    return step;
  }, [ensureSaved, read]);

  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    failed.current = false;
    retries.current = 0;
    chain.current = Promise.resolve(true);
    setStatus("loading");
    setEpoch((value) => value + 1);
  }, []);

  /* Leaving the page flushes what is pending. */
  useEffect(() => () => {
    if (timer.current) void flush();
  }, [flush]);

  return {
    status: scope && projectId ? status : "error",
    project,
    saveState,
    error: scope && projectId ? error : "Open a saved project first.",
    change,
    ensureSaved,
    refresh,
    reload,
  };
}
