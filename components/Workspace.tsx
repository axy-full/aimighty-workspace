"use client";

/**
 * Generate — the landing screen.
 *
 * Three things on it, and nothing else: the wall of renders (Feed), the
 * island you write the next one on (Composer), and the setup that every
 * render carries with it (SetupPanel). A tile opens the theatre. The state
 * lives here; the pieces are dumb on purpose.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { referenceProblem, type RefItem, type RefPicker } from "./References";
import { appAlert, appConfirm } from "./dialog";
import type { Gen } from "./GenCard";
import Feed, { type FeedFilter } from "./Feed";
import Composer, { type Engine, type WriterInfo } from "./Composer";
import Theatre from "./Theatre";
import SetupPanel from "./SetupPanel";
import { useApi } from "@/lib/useApi";
import { usePageTitle } from "@/lib/usePageTitle";
import { composePrompt, specCount, type ShotSpec } from "@/lib/studio";
import {
  DEFAULT_MODEL_ID, getModel, dimensionsFor,
  estimateCostUsd, estimateTokens, estimateImageCostUsd,
} from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { useProject } from "@/lib/projectContext";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
};

const SETUP_KEY = "aw_setup_open";

export default function Workspace() {
  usePageTitle("Generate");
  const { selection: bin, current, refreshProjects } = useProject();
  const prefs = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Artlist-style shot control: one choice per category, appended at submit. */
  const [spec, setSpec] = useState<ShotSpec>({});
  /** Which shot this take belongs to — what makes it v3 of SH110. */
  const [shotId, setShotId] = useState<string>("");
  /** Editing or extending an existing render, rather than making a new one.
   *  Both are LOCKED tasks: the source decides the output's shape. */
  const [taskOn, setTaskOn] = useState<{ id: "edit" | "extend"; gen: Gen } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [setupOpen, setSetupOpen] = useState(true);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<RefPicker>(null);
  const islandRef = useRef<HTMLDivElement>(null);

  // The island's height, published for anything that floats near the bottom
  // of the screen (the chat bubble) so it can stay clear of the render button
  // on a phone. Cleared when this screen goes away.
  useEffect(() => {
    const el = islandRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // On <body>, not <html>: ViewportGuard owns the root element's inline
    // style for --kb and rewrites it on every viewport event, which on a
    // phone silently wiped this variable within seconds of it being set.
    const host = document.body;
    const ro = new ResizeObserver(() => {
      // The border box, padding included — what actually has to be cleared.
      host.style.setProperty("--island-h", `${Math.round(el.offsetHeight)}px`);
    });
    ro.observe(el);
    return () => { ro.disconnect(); host.style.removeProperty("--island-h"); };
  }, []);

  // Which vendors have keys — decides which engines the menu will offer.
  const { data: engineData } = useApi<{ engines: Engine[]; refiner?: WriterInfo }>("/api/engines", 0);
  const engines = useMemo(() => engineData?.engines ?? [], [engineData]);
  const writer = engineData?.refiner ?? null;

  // The composer opens on whatever Settings says, then stays where you put it.
  const [params, setParams] = useState<Params>(() => ({
    modelId: DEFAULT_MODEL_ID, ratio: "16:9", resolution: "1080p", duration: 5,
    watermark: false, generateAudio: false, seed: "",
  }));
  const seeded = useRef(false);
  /** Set the moment a person changes any control — from then on Settings
   *  defaults stop overwriting what they chose. */
  const touched = useRef(false);
  useEffect(() => {
    if (!seeded.current) {
      seeded.current = true;
      // Work handed over from elsewhere — a card from the canvas, or a prompt
      // and shot spec built in the Studio — and the setup panel's last state.
      // Read after mount, never in a useState initializer: the server has no
      // localStorage, so seeding at first render hydrates wrong.
      try {
        const carried = window.localStorage.getItem("aw_compose_seed");
        const carriedSpec = window.localStorage.getItem("aw_compose_spec");
        const setup = window.localStorage.getItem(SETUP_KEY);
        if (carried) window.localStorage.removeItem("aw_compose_seed");
        if (carriedSpec) window.localStorage.removeItem("aw_compose_spec");
        Promise.resolve().then(() => {
          if (carried) setPrompt(carried);
          if (carriedSpec) {
            try { setSpec(JSON.parse(carriedSpec) as ShotSpec); }
            catch { /* a spec we can't read is one we don't apply */ }
          }
          if (setup === "0") setSetupOpen(false);
        });
      } catch { /* private mode — nothing carried, nothing lost */ }
    }
    // The prefs store hydrates with its server fallback and only reads the
    // browser's saved defaults in a later pass, so this has to follow `prefs`
    // rather than run once — until the person touches a control.
    if (touched.current) return;
    const m = getModel(prefs.modelId);
    setParams((s) => ({
      ...s,
      modelId: m.id,
      resolution: m.resolutions.includes(prefs.resolution) ? prefs.resolution : s.resolution,
      duration: m.durations.includes(prefs.duration) ? prefs.duration : s.duration,
    }));
  }, [prefs]);

  const patch = (p: Partial<Params>) => { touched.current = true; setParams((s) => ({ ...s, ...p })); };

  function toggleSetup() {
    // On a phone the setup always sits below the wall, so the chip is a
    // shortcut to it rather than a switch.
    if (typeof matchMedia !== "undefined" && matchMedia("(max-width: 860px)").matches) {
      document.querySelector(".setup")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setSetupOpen((v) => {
      try { window.localStorage.setItem(SETUP_KEY, v ? "0" : "1"); } catch { /* fine */ }
      return !v;
    });
  }

  function switchModel(next: string) {
    setErr(null);          // the old failure was about the old engine
    const m = getModel(next);
    patch({
      modelId: next,
      ratio: m.ratios.includes(params.ratio) ? params.ratio : m.ratios.includes("16:9") ? "16:9" : m.ratios[0],
      resolution: m.resolutions.includes(params.resolution)
        ? params.resolution
        : m.kind === "image" ? "2K" : m.resolutions[0],
      duration: m.durations.includes(params.duration) ? params.duration : m.durations[0] ?? params.duration,
      generateAudio: m.supportsAudio ? params.generateAudio : false,
    });
    if (m.kind === "image") {
      setRefs((prev) => prev.map((r) =>
        r.kind === "image" && r.role !== "reference_image" ? { ...r, role: "reference_image" } : r
      ));
      if (taskOn) setTaskOn(null);   // stills can't be edited or extended
    }
  }

  const query =
    bin === "all" || bin === "unfiled" ? "" : `&projectId=${encodeURIComponent(bin)}`;
  const { data, refresh } = useApi<{ generations: Gen[] }>(`/api/jobs?limit=60${query}`, 5000);
  const gens = useMemo(() => {
    const all = data?.generations ?? [];
    return bin === "unfiled" ? all.filter((g) => !g.projectId) : all;
  }, [data, bin]);

  // The Clips/Stills filter lives here so the wall and the theatre agree on
  // what "next" means.
  const clips = gens.filter((g) => g.kind !== "image").length;
  const mixed = clips > 0 && clips < gens.length;
  const visible = useMemo(
    () => !mixed || filter === "all"
      ? gens
      : gens.filter((g) => (filter === "image" ? g.kind === "image" : g.kind !== "image")),
    [gens, mixed, filter]
  );
  const activeId = selected && visible.some((g) => g.id === selected) ? selected : null;

  const modelDef = getModel(params.modelId);
  const isImage = modelDef.kind === "image";
  const refProblem = referenceProblem(refs, modelDef, prompt);
  const hasVideoInput = refs.some((r) => r.kind === "video");
  const inputSeconds = refs
    .filter((r) => r.kind === "video")
    .reduce((a, r) => a + (r.durationS ?? 0), 0);
  const imageRefCount = refs.filter((r) => r.kind === "image").length;
  const est = isImage
    ? estimateImageCostUsd(params.modelId, params.resolution, imageRefCount)
    : estimateCostUsd(
        params.modelId, params.resolution, params.ratio, params.duration,
        inputSeconds, hasVideoInput
      );
  const estTokens = isImage
    ? null
    : estimateTokens(params.resolution, params.ratio, params.duration, inputSeconds);
  const dims = isImage ? null : dimensionsFor(params.resolution, params.ratio);

  function afterChange() { refresh(); refreshProjects(); }

  /** Drop an @ImageN or @Name token in at the caret so the prompt can address it. */
  const cite = useCallback((token: string) => {
    const el = promptRef.current;
    if (!el) { setPrompt((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}${token} `); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${token} ${el.value.slice(end)}`;
    setPrompt(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length + 1;
      el.setSelectionRange(caret, caret);
    });
  }, []);

  async function render() {
    // The same conditions that disable the send button. The guard lives HERE
    // rather than only on the button, because Cmd/Ctrl+Enter calls render()
    // directly — it was posting reference payloads the UI had already
    // declared invalid, producing a failed render from a blocked control.
    if (!prompt.trim() || busy || refProblem) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: composePrompt(prompt, spec),
          model: params.modelId, ratio: params.ratio,
          resolution: params.resolution, duration: params.duration,
          watermark: params.watermark, generateAudio: params.generateAudio,
          seed: params.seed || null,
          projectId: bin !== "all" && bin !== "unfiled" ? bin : null,
          task: taskOn?.id ?? "generate",
          sourceGenId: taskOn?.gen.id ?? null,
          shotId: shotId || null,
          shotSpec: spec,
          references: refs.map((r) => ({ uploadId: r.id, role: r.role })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Submit failed");
      setPrompt("");
      setRefs([]);
      setTaskOn(null);
      if (Array.isArray(json?.notices) && json.notices.length) {
        await appAlert("Sent", json.notices.join("\n\n"));
      }
      // The spec and the shot deliberately survive: the reason to have shot
      // control at all is changing one chip and running the take again.
      if (!json?.id) throw new Error("Submit failed");
      afterChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function useGen(gen: Gen) {
    if (prompt.trim() &&
        !(await appConfirm("Replace the composer?", "This render's prompt will replace what you've typed.", { confirmLabel: "Replace" }))) return;
    // Hand back what was typed — cast names, not the @ImageN they became.
    const typed = (gen.params as { rawPrompt?: string }).rawPrompt;
    setPrompt(typed || gen.prompt);
    setSelected(null);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  function editExtend(id: "edit" | "extend", gen: Gen) {
    if (isImage) switchModel(DEFAULT_MODEL_ID);
    setTaskOn({ id, gen });
    setPrompt(id === "edit" ? "Replace " : "Continue from the final frame: ");
    setSelected(null);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  const scopeName = bin === "all" ? "All projects" : bin === "unfiled" ? "Unfiled" : current?.name ?? "";
  const setupCount = specCount(spec) + (shotId ? 1 : 0);

  return (
    <div className={`generate ${setupOpen ? "" : "generate-solo"}`}>
      <Feed
        gens={gens} visible={visible} activeId={activeId} onOpen={setSelected}
        filter={filter} setFilter={setFilter} scopeName={scopeName}
      />

      <div className="island" ref={islandRef}>
        <Composer
          prompt={prompt} setPrompt={(v) => { setPrompt(v); if (err) setErr(null); }}
          promptRef={promptRef}
          params={params} patch={patch} switchModel={switchModel}
          model={modelDef} engines={engines} writer={writer}
          refs={refs} setRefs={setRefs} picker={picker} cite={cite}
          taskOn={taskOn} cancelTask={() => setTaskOn(null)}
          problem={refProblem ?? err} blocked={Boolean(refProblem)}
          est={est} estTokens={estTokens} dims={dims}
          inputSeconds={inputSeconds} hasVideoInput={hasVideoInput} imageRefCount={imageRefCount}
          busy={busy} onRender={render}
          setupCount={setupCount} setupOpen={setupOpen} toggleSetup={toggleSetup}
        />
      </div>

      <aside className="setup">
        <SetupPanel
          projectId={bin} shotId={shotId} setShotId={setShotId}
          spec={spec} setSpec={setSpec} onCite={cite}
          onClose={toggleSetup}
        />
      </aside>

      <Theatre
        gens={visible} activeId={activeId}
        onClose={() => setSelected(null)} onSelect={setSelected}
        onChanged={afterChange} onUse={useGen} onEditExtend={editExtend}
      />
    </div>
  );
}
