"use client";
import { useCallback, useRef, useState } from "react";
import { priceWords, upTo } from "@/lib/shell/price-words";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { ProjectSummary } from "@/lib/workspace/data";
import { uploadFilesToProject } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { EMPTY_DRAFT, TEMPLATES, cleanDraft, goalFor, newProjectFor, reusable, type BoardKind, type HomeDraft, type HomeSeed, type MadeHere, type Template, type TemplateId } from "./home-model";
import { askAtomik, planningFor, productionOf } from "./start";
import { useThinkingPrice } from "./use-thinking-price";

/**
 * Today's create path (the shell's createProject: `newProject(name)` with the seed's fields set, then
 * PUT /api/workbench/projects): it opens the project it made and answers its id (and its production,
 * when the save's reply named it), or why it could not.
 */
export type CreateFromSeed = (name: string, seed: HomeSeed) => Promise<{ id: string; productionId?: string | null } | { error: string }>;

/** Where the surface goes once a project is open: the desktop's board, the phone's Record. With `atomik`, Atomik's thinking has been asked. */
export type OpenBoard = (kind?: BoardKind, start?: "script", atomik?: boolean) => void;

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

/** A project Start made whose ask stopped (a higher figure, a refusal): the next press asks again for it rather than making another. */
type Started = { id: string; productionId: string | null; text: string; figure: number | null };
const FILM = TEMPLATES[0];

/**
 * Everything "What are we making?" does, shared by the desktop Home and the phone's Home: the box's draft
 * (saved as `home`), the files, the templates' create, and Start · up to N cr. It is the code Home had in
 * place, moved here unchanged so both surfaces make and start a project the same way; there is no second
 * create or start path. Only `openBoard` differs: where the surface goes once the project is open.
 */
export function useHomeStart({ scope, projects, onPick, onCreate, onStarter, openBoard }: {
  scope: string;
  projects: readonly ProjectSummary[];
  onPick: (id: string) => void;
  onCreate: CreateFromSeed;
  /** Opens the workspace's starter production (the sample); the refusal, or null. Only the desktop Home offers it. */
  onStarter?: () => Promise<string | null>;
  openBoard: OpenBoard;
}) {
  const { toast } = useWorkspace();
  const fetcher = useScopedFetch(scope);
  const stored = useDraft<HomeDraft>("home", EMPTY_DRAFT);
  const draft = cleanDraft(stored.value);
  const setDraft = stored.set;
  const clearDraft = stored.clear;
  const [refs, setRefs] = useState<File[]>([]);
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [pending, setPending] = useState<TemplateId | "sample" | "start" | null>(null);
  const [problem, setProblem] = useState("");
  const [startProblem, setStartProblem] = useState("");
  const [started, setStarted] = useState<Started | null>(null);
  const busy = useRef(false);
  const { thinking, retry: retryThinking } = useThinkingPrice(scope);

  /* The figure on Start: the server's for a new board, or the newer one it gave for the project Start already made. */
  const own = started && started.text === draft.text ? started : null;
  const figure = own?.figure ?? (thinking.state === "ready" ? thinking.credits : null);

  const onDraft = useCallback((next: HomeDraft | ((now: HomeDraft) => HomeDraft)) => {
    setDraft((before) => cleanDraft(typeof next === "function" ? next(cleanDraft(before)) : next));
  }, [setDraft]);

  const forget = () => { clearDraft(); setRefs([]); setBriefFile(null); setStarted(null); };

  /** Makes the project with what the box holds and files its files: its id and production, or the refusal (said by the caller). */
  const make = async (template: Template): Promise<{ id: string; productionId: string | null } | { error: string }> => {
    const { name, seed } = newProjectFor(template, draft);
    const made = await onCreate(name, seed).catch(() => ({ error: "The project could not be created. Try again." }));
    if ("error" in made) return made;
    rememberMade(scope, { id: made.id, template: template.id, at: Date.now() });
    const files = [...(briefFile ? [briefFile] : []), ...refs];
    if (files.length) {
      /* Filed before the board opens, so they are in its Library; one that fails is named, the rest still land. */
      const added = await uploadFilesToProject(scope, made.id, files).catch((cause: unknown) => ({ notes: [cause instanceof Error ? cause.message : "The files could not be added."] }));
      if (added.notes.length) toast(added.notes.join(" "));
      setRefs([]);
      setBriefFile(null);
    }
    return { id: made.id, productionId: made.productionId ?? null };
  };

  /* One press makes one project: a second press while the first is on its way is ignored. */
  const create = async (template: Template) => {
    if (busy.current) return;
    setProblem("");
    const blank = !draft.text.trim() && draft.aspect === null && draft.length === null && !refs.length && !briefFile;
    const again = blank ? reusable(readMade(scope), template.id, projects) : null;
    if (again) {
      onPick(again);
      openBoard(template.kind, template.start);
      return;
    }
    busy.current = true;
    setPending(template.id);
    try {
      const made = await make(template);
      if ("error" in made) { setProblem(made.error); return; }
      forget();
      openBoard(template.kind, template.start);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  /**
   * Start · up to N cr: a person's press approves Atomik's thinking up to N. The project is made (free), its
   * figure read again; a higher one is shown for another press, never spent. Then today's ask, with a limit of N.
   */
  const start = async () => {
    if (busy.current || figure == null) return;
    setStartProblem("");
    const goal = goalFor(draft);
    if (!goal) { setStartProblem("Say what we are making, or pick a template."); return; }
    busy.current = true;
    setPending("start");
    try {
      let project: Started | null = own;
      if (!project) {
        const made = await make(FILM);
        if ("error" in made) { setStartProblem(made.error); return; }
        project = { ...made, text: draft.text, figure: null };
      }
      const production = project.productionId ? { productionId: project.productionId } : await productionOf(fetcher, project.id);
      if ("error" in production) { setStarted(project); setStartProblem(production.error); return; }
      project = { ...project, productionId: production.productionId };
      const terms = await planningFor(fetcher, production.productionId, project.id);
      if ("error" in terms) { setStarted(project); setStartProblem(terms.error); return; }
      if (terms.planning > figure) {
        setStarted({ ...project, figure: terms.planning });
        setStartProblem(`For this brief, Atomik's thinking may cost ${priceWords(upTo(terms.planning))}. Press Start again to approve it.`);
        return;
      }
      const asked = await askAtomik(fetcher, { productionId: production.productionId, draftId: project.id, goal, limit: figure, requestId: crypto.randomUUID() });
      if ("error" in asked) { setStarted(project); setStartProblem(asked.error); return; }
      forget();
      /* One move: the board with Atomik's panel docked beside it (two writes in a row would leave the second reading the address as it was). */
      openBoard("studio", undefined, true);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  /** A project card: open it unless a press is on its way. */
  const open = (id: string) => {
    if (busy.current) return;
    onPick(id);
    openBoard();
  };

  const openSample = async () => {
    if (busy.current || !onStarter) return;
    busy.current = true;
    setPending("sample");
    setProblem("");
    try {
      const why = await onStarter().catch(() => "The sample could not be opened. Try again.");
      if (why) setProblem(why); else openBoard();
    } finally {
      busy.current = false;
      setPending(null);
    }
  };

  return { draft, onDraft, refs, setRefs, briefFile, setBriefFile, pending, problem, startProblem, thinking, retryThinking, figure, create, start, open, openSample };
}
