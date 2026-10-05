"use client";
import { useCallback, useRef, useState } from "react";
import { throwIfArmed } from "@/lib/shell/fault";
import { useDraft } from "@/lib/useDraft";
import type { ProjectSummary } from "@/lib/workspace/data";
import { uploadFilesToProject } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { BriefBox } from "./BriefBox";
import { BLANK, EMPTY_DRAFT, cleanDraft, newProjectFor, reusable, type HomeDraft, type HomeSeed, type MadeHere, type Template, type TemplateId } from "./home-model";
import { ProjectGrid } from "./ProjectGrid";
import { TemplateRow } from "./TemplateRow";
import { useHomeNav } from "./use-home-nav";
import "./home.css";

/**
 * What the shell hands Home (stream 1 mounts it at `?view=home` with the new interface on). `onCreate` is
 * today's create path (the shell's createProject: `newProject(name)` with the seed's fields set, then
 * PUT /api/workbench/projects): it opens the project it made and answers its id, or why it could not.
 */
export type HomeViewProps = {
  scope: string;
  projects: ProjectSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  onPick: (id: string) => void;
  onCreate: (name: string, seed: HomeSeed) => Promise<{ id: string } | { error: string }>;
  /** Opens the workspace's starter production (the sample until stream 12's lands); the refusal, or null. */
  onStarter: () => Promise<string | null>;
  now: number;
};

/* The projects this tab made from a template, for "an untouched project from the same session is reused" (lead decision 23). */
const madeKey = (scope: string) => `particl-home-made:${scope}`;
function readMade(scope: string): MadeHere[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(madeKey(scope)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is MadeHere => Boolean(m) && typeof m.id === "string" && typeof m.template === "string" && typeof m.at === "number").slice(-20) : [];
  } catch { return []; }
}
function rememberMade(scope: string, made: MadeHere) {
  try { sessionStorage.setItem(madeKey(scope), JSON.stringify([...readMade(scope), made].slice(-20))); } catch { /* private storage: nothing is reused, a new project is made */ }
}

/**
 * Home (design/particl-graphite/README.md § 1.1; the master's `?view=home`): "What are we making?", the
 * templates, and the person's projects. Waiting for you and Start (with Atomik's thinking price) come
 * with PR b, on stream 8's approval queue. Make, Atomik's panel, ⌘K and the Settings menu open over it;
 * the shell's `--gx-overlay-right` keeps the column clear of an open right panel.
 */
export function HomeView({ scope, projects, status, error, onRetry, onPick, onCreate, onStarter, now }: HomeViewProps) {
  throwIfArmed("home");
  const { toast } = useWorkspace();
  const nav = useHomeNav();
  const stored = useDraft<HomeDraft>("home", EMPTY_DRAFT);
  const draft = cleanDraft(stored.value);
  const setDraft = stored.set;
  const clearDraft = stored.clear;
  const [refs, setRefs] = useState<File[]>([]);
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [pending, setPending] = useState<TemplateId | "sample" | null>(null);
  const [problem, setProblem] = useState("");
  const busy = useRef(false);

  const onDraft = useCallback((next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => {
    setDraft((before) => cleanDraft(typeof next === "function" ? next(cleanDraft(before)) : next));
  }, [setDraft]);

  /* One press makes one project: a second press while the first is on its way is ignored. */
  const create = async (template: Template) => {
    if (busy.current) return;
    setProblem("");
    const blank = !draft.text.trim() && draft.aspect === null && draft.length === null && !refs.length && !briefFile;
    const again = blank ? reusable(readMade(scope), template.id, projects) : null;
    if (again) {
      onPick(again);
      nav.openBoard(template.kind, template.start);
      return;
    }
    busy.current = true;
    setPending(template.id);
    try {
      const { name, seed } = newProjectFor(template, draft);
      const made = await onCreate(name, seed).catch(() => ({ error: "The project could not be created. Try again." }));
      if ("error" in made) { setProblem(made.error); return; }
      rememberMade(scope, { id: made.id, template: template.id, at: Date.now() });
      const files = [...(briefFile ? [briefFile] : []), ...refs];
      if (files.length) {
        /* Filed before the board opens, so they are in its Library; one that fails is named, the rest still land. */
        const added = await uploadFilesToProject(scope, made.id, files).catch((cause: unknown) => ({ notes: [cause instanceof Error ? cause.message : "The files could not be added."] }));
        if (added.notes.length) toast(added.notes.join(" "));
      }
      clearDraft();
      setRefs([]);
      setBriefFile(null);
      nav.openBoard(template.kind, template.start);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  const open = (id: string) => {
    if (busy.current) return;
    onPick(id);
    nav.openBoard();
  };

  const openSample = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending("sample");
    setProblem("");
    try {
      const why = await onStarter().catch(() => "The sample could not be opened. Try again.");
      if (why) setProblem(why); else nav.openBoard();
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  return (
    <div className="gx-hm gx-scroll" data-testid="home" data-screen-label="Home">
      <div className="gx-hm-col">
        <section className="gx-hm-make" aria-labelledby="gx-hm-title">
          <h1 className="gx-hm-title" id="gx-hm-title" data-testid="page-title">What are we making?</h1>
          <BriefBox draft={draft} onDraft={onDraft} refs={refs} onRefs={setRefs} briefFile={briefFile} onBriefFile={setBriefFile} busy={pending !== null} />
        </section>
        <div className="gx-hm-starts">
          <TemplateRow pending={pending === "sample" ? null : pending} disabled={pending !== null} onPick={(t) => void create(t)} />
          {problem ? <p className="gx-hm-problem" role="alert" data-testid="home-problem">{problem}</p> : null}
        </div>
        <ProjectGrid scope={scope} projects={projects} status={status} error={error} onRetry={onRetry} now={now} disabled={pending !== null}
          onOpen={open} onNew={() => void create(BLANK)} onSample={() => void openSample()} />
      </div>
    </div>
  );
}
