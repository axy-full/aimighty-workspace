"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { mergeDraft, rebaseProject } from "@/lib/workbench/draft-merge";
import { noteTakenOut, recordMade, sameJson, type MadeRecords } from "@/lib/workbench/merge";
import {
  DraftRequestError,
  draftRequest,
  draftWriter,
  writeMergedDraft,
  type DraftWriter,
} from "@/lib/workbench/draft-request";
import { useOptionalToast } from "@/lib/workspace/state";

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
 * edited copy, and what each change made (recordMade: an agent run's places, a
 * breakdown, a filed take); what a change takes out of such records is noted
 * in the draft (noteTakenOut). When another save landed first (the Rig, another
 * stage, another tab), the edits made since `base` are merged into the newer
 * version (lib/workbench/merge.ts) and saved at its revision, and the page
 * then shows the merged draft: nothing either side added or changed is lost,
 * and what did not fit a full list is said (`notice`). A save whose outcome is
 * unknown is kept and tried again; the server is first asked whether it
 * landed (writeMergedDraft), so what was typed or undone meanwhile is saved as
 * such. Edits not saved yet when the page closes (or opens another project)
 * keep being saved, and a page that opens the project again takes them up.
 * Any other rejected save keeps the edits on screen and says why; the next
 * edit tries again, and `reload` discards them for the saved version.
 */

export type DraftEditor = {
  status: "loading" | "ready" | "error";
  project: Project | null;
  /** "Saved", "Saving", "Not saved" — or the load error. */
  saveState: string;
  error: string;
  /** What of this page's edits a merge could not fit (a full list another window filled first); empty when nothing. */
  notice: string;
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

/** True when the edited draft is exactly what the server holds (and no save of it is left unconfirmed). */
const settled = (edited: Project | null, saved: Project | null, unconfirmed = false) => !edited || (!unconfirmed && sameJson(edited, saved));

/**
 * A draft a page left with edits not saved yet (it closed, or opened another
 * project): saved on its own until it is, unless a page opens it again first
 * — that page then takes it up once the attempt in flight has ended.
 */
type Parked = {
  current: Project;
  base: Project;
  revision: number;
  writer: DraftWriter;
  made: MadeRecords;
  stop: boolean;
  wake: () => void;
  /** The attempt in flight (or the save the page had in flight when it left); resolves when it ends. */
  inflight: Promise<unknown>;
  /** Set once a save of it landed (its own, or the page's that was in flight): `base`, `revision` and `current` are what the server holds then. */
  saved: boolean;
};
const parked = new Map<string, Parked>();
const parkKey = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);
/* A parked draft by its writer: a save the page had in flight when it left moves the draft's base on when it lands. */
const parkedBy = new WeakMap<DraftWriter, Parked>();

function park(scope: string, entry: Omit<Parked, "stop" | "wake" | "saved">) {
  const key = parkKey(scope, entry.current.id);
  const held: Parked = { ...entry, stop: false, wake: () => {}, saved: false };
  parked.set(key, held);
  parkedBy.set(held.writer, held);
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      await held.inflight.catch(() => undefined);
      if (held.stop || settled(held.current, held.base, !!held.writer.unconfirmed)) break;
      const snapshot = held.current;
      const step = writeMergedDraft(API, scope, { base: held.base, mine: snapshot, revision: held.revision, writer: held.writer, made: held.made })
        .then((saved) => {
          held.base = saved.project;
          held.revision = saved.revision;
          held.current = rebaseProject(snapshot, held.current, saved.project);
          held.saved = true;
          return true;
        })
        .catch((problem: unknown) => {
          /* Refused outright: kept as it is, for the page that opens it again to show with why. */
          if (!(problem instanceof DraftRequestError && (problem.uncertain || problem.retryable))) held.stop = true;
          return false;
        });
      held.inflight = step;
      if (await step) continue;
      if (held.stop) break;
      await new Promise<void>((resolve) => {
        held.wake = resolve;
        setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** attempt));
      });
    }
    if (parked.get(key) === held && settled(held.current, held.base, !!held.writer.unconfirmed)) parked.delete(key);
  })();
}

export function useDraftEditor(scope: string | null, projectId: string | null): DraftEditor {
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<DraftEditor["status"]>("loading");
  const [saveState, setSaveState] = useState("Loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [epoch, setEpoch] = useState(0);

  /** The edited draft. */
  const current = useRef<Project | null>(null);
  /** The draft exactly as the server holds it at `revision`: what the edits are merged from. */
  const base = useRef<Project | null>(null);
  const revision = useRef(0);
  const failed = useRef(false);
  const retries = useRef(0);
  /** This editor's saves of the open draft: a save whose reply was lost is checked on the server, never guessed at. */
  const writer = useRef(draftWriter());
  /** What this editor's changes made, as made: a record another window made from the same source merges from it. */
  const made = useRef<MadeRecords>(new Map());
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const retry = useRef<() => void>(() => {});
  /** Which draft this editor holds ([scope, project, reload]): opening it again (React's second mount in development) keeps it. */
  const opened = useRef("");
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  /* What a merge could not fit is said where the person looks, as well as on the page. */
  const toast = useOptionalToast();
  useEffect(() => { if (notice) toast?.(notice); }, [notice, toast]);

  /* Edits not saved yet keep being saved once the page leaves this draft (closing, or opening another project). */
  const leave = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const edited = current.current, from = base.current, where = scopeRef.current;
    if (!edited || !from || !where || settled(edited, from, !!writer.current.unconfirmed)) return;
    park(where, { current: edited, base: from, revision: revision.current, writer: writer.current, made: made.current, inflight: chain.current });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      leave();
    };
  }, [leave]);

  const read = useCallback(
    async (id: string) => draftRequest<Loaded>(`${API}/projects?id=${encodeURIComponent(id)}`, scope ?? ""),
    [scope],
  );

  useEffect(() => {
    if (!scope || !projectId) return;
    const key = JSON.stringify([scope, projectId, epoch]);
    let active = true;
    /* Another project's edits not saved yet: they keep being saved. */
    if (current.current && current.current.id !== projectId) leave();
    const back = parked.get(parkKey(scope, projectId));
    /* The draft this editor already holds (React mounts twice in development): kept, not read again. */
    if (!back && opened.current === key && current.current?.id === projectId) return;
    failed.current = false;
    retries.current = 0;
    if (back) {
      /* This draft's edits, still being saved from when a page left it: they are the draft again. What the save
         in flight saves becomes the base once it ends; saves from here wait for it. */
      parked.delete(parkKey(scope, projectId));
      back.stop = true;
      back.wake();
      opened.current = key;
      const shown = back.current;
      current.current = shown;
      base.current = back.base;
      revision.current = back.revision;
      writer.current = back.writer;
      made.current = back.made;
      /* Shown once this effect has run (state set in a callback, not in the effect's own body). */
      queueMicrotask(() => {
        if (!active || current.current?.id !== projectId) return;
        setProject(current.current);
        setStatus("ready");
        setSaveState("Saving");
        setError("");
        setNotice("");
      });
      chain.current = back.inflight.catch(() => undefined).then(() => {
        if (!back.saved || current.current?.id !== projectId) return true;
        base.current = back.base;
        revision.current = back.revision;
        writer.current = back.writer;
        current.current = rebaseProject(shown, current.current, back.current);
        if (alive.current) setProject(current.current);
        return true;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => retry.current(), SAVE_DELAY_MS);
      return () => { active = false; };
    }
    read(projectId)
      .then((data) => {
        if (!active) return;
        opened.current = key;
        current.current = data.project;
        base.current = data.project;
        revision.current = data.revision;
        writer.current = draftWriter();
        made.current = new Map();
        failed.current = false;
        retries.current = 0;
        setProject(data.project);
        setStatus(data.project ? "ready" : "error");
        setSaveState(data.project ? "Saved" : "Not found");
        setError(data.project ? "" : "This project could not be opened.");
        setNotice("");
      })
      .catch((problem: unknown) => {
        if (!active) return;
        setStatus("error");
        setError(problem instanceof Error ? problem.message : "This project could not be opened.");
      });
    return () => {
      active = false;
    };
  }, [scope, projectId, read, epoch, leave]);

  /** Saves the edited draft; true once the write succeeded (edits made meanwhile are saved by the next flush). */
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    chain.current = chain.current.catch(() => false).then(async () => {
      const snapshot = current.current, from = base.current, by = writer.current;
      if (!snapshot || !from || !scope) return false;
      if (failed.current) return false;
      /* Back to what the server held — unless a save is unconfirmed: then the server may hold that save, and this is an edit. */
      if (sameJson(snapshot, from) && !writer.current.unconfirmed) return true;
      if (alive.current) setSaveState("Saving");
      try {
        const saved = await writeMergedDraft(API, scope, { base: from, mine: snapshot, revision: revision.current, writer: by, made: made.current });
        /* The page left this draft while the save was out, and its edits went on saving on their own (park): from what
           this save saved, never from the base before it — or a save that landed would be merged in again. */
        const held = parkedBy.get(by);
        if (held && !held.saved && held.base === from) {
          held.base = saved.project;
          held.revision = saved.revision;
          held.current = rebaseProject(snapshot, held.current, saved.project);
          held.saved = true;
        }
        /* Another project opened meanwhile: its own draft stands. */
        if (current.current?.id !== snapshot.id) return true;
        retries.current = 0;
        revision.current = saved.revision;
        base.current = saved.project;
        /* The page shows what was saved — another window's edits included — with any edits made meanwhile laid over it. */
        const next = rebaseProject(snapshot, current.current, saved.project);
        current.current = next;
        if (alive.current) {
          setProject(next);
          setSaveState(settled(next, saved.project) ? "Saved" : "Saving");
          setError("");
          setNotice(saved.notes.join(" "));
        }
        return true;
      } catch (problem) {
        /* Another project opened meanwhile: this draft's edits went on saving on their own (leave). */
        if (current.current?.id !== snapshot.id) return false;
        const message = problem instanceof Error ? problem.message : "Save failed. Your current work is preserved.";
        if (problem instanceof DraftRequestError && (problem.uncertain || problem.retryable)) {
          /* Unknown or temporary: the edits stay, and the save is tried again once the server can say whether it landed. */
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
      const changed = fn(previous);
      if (changed === previous) return;
      /* What it made, as made, and what it took out of what windows make alike: the merge reads both. */
      const next = noteTakenOut(previous, changed);
      recordMade(made.current, previous, next);
      current.current = next;
      setProject(next);
      /* A refused save held the edits; this edit may be what the server needed. It tries again. */
      failed.current = false;
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
      if (settled(current.current, base.current, !!writer.current.unconfirmed)) return true;
    }
    return settled(current.current, base.current, !!writer.current.unconfirmed);
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
      const next = edited && from ? mergeDraft(from, edited, data.project, { made: made.current }) : data.project;
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
    /* The saved version replaces these edits: none are taken up or kept saving. */
    current.current = null;
    setStatus("loading");
    setEpoch((value) => value + 1);
  }, []);

  return {
    status: scope && projectId ? status : "error",
    project,
    saveState,
    error: scope && projectId ? error : "Open a saved project first.",
    notice,
    change,
    ensureSaved,
    refresh,
    reload,
  };
}
