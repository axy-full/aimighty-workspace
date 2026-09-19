"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import {
  DraftRequestError,
  draftRequest,
  writeDraft,
} from "@/lib/workbench/draft-request";

/**
 * An editable copy of one project draft for a workspace page that mounts a
 * Studio panel (Brief & Script, Boards, Astra 3D).
 *
 * It is the pattern the suites already use (AtomikGenerate, SubatomikWorkspace):
 * read the draft and its revision from GET /api/workbench/projects, write it
 * back with lib/workbench/draft-request's `writeDraft` — which checks the
 * revision and reconciles a lost reply — and never write over another
 * window's newer revision. Edits are saved 650ms after the last change, like
 * Studio. A rejected save stops further saves and keeps the edits on screen;
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

type Loaded = { project: Project | null; revision: number };

export function useDraftEditor(scope: string | null, projectId: string | null): DraftEditor {
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<DraftEditor["status"]>("loading");
  const [saveState, setSaveState] = useState("Loading");
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);

  const current = useRef<Project | null>(null);
  const revision = useRef(0);
  const saved = useRef("");
  const failed = useRef(false);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

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
        revision.current = data.revision;
        saved.current = data.project ? JSON.stringify(data.project) : "";
        failed.current = false;
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

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.then(async () => {
      const snapshot = current.current;
      if (!snapshot || !scope) return false;
      if (failed.current) return false;
      const text = JSON.stringify(snapshot);
      if (text === saved.current) return true;
      if (alive.current) setSaveState("Saving");
      try {
        const receipt = await writeDraft(API, scope, { project: snapshot, revision: revision.current });
        revision.current = receipt.revision;
        const stored = { ...snapshot, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings };
        saved.current = JSON.stringify(stored);
        /* Server identities join the edits made while the request was out. */
        if (current.current?.id === snapshot.id) {
          const next = { ...current.current, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings };
          current.current = next;
          if (alive.current) setProject(next);
        }
        const clean = JSON.stringify(current.current) === saved.current;
        if (alive.current) {
          setSaveState(clean ? "Saved" : "Saving");
          setError("");
        }
        return clean;
      } catch (problem) {
        failed.current = true;
        if (alive.current) {
          setSaveState(problem instanceof DraftRequestError && problem.uncertain ? "Save unconfirmed" : "Not saved");
          setError(problem instanceof Error ? problem.message : "Save failed. Your current work is preserved.");
        }
        return false;
      }
    });
    return chain.current;
  }, [scope]);

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
    const ok = await flush();
    /* Edits made during the write are saved by the next flush. */
    return ok && JSON.stringify(current.current) === saved.current ? true : ok ? flush() : false;
  }, [flush]);

  const refresh = useCallback(async () => {
    const id = current.current?.id;
    if (!id) return null;
    if (!(await ensureSaved())) throw new Error("Save this project before loading its saved outputs.");
    const data = await read(id);
    if (!data.project || current.current?.id !== id) return null;
    revision.current = data.revision;
    saved.current = JSON.stringify(data.project);
    current.current = data.project;
    if (alive.current) setProject(data.project);
    return data.project;
  }, [ensureSaved, read]);

  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    failed.current = false;
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
