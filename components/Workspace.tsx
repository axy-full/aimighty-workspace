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
import { usePrice } from "@/lib/price";
import { referenceProblem, type RefItem, type RefPicker } from "./References";
import { appAlert, appConfirm } from "./dialog";
import type { Gen } from "./GenCard";
import Feed, { type FeedFilter } from "./Feed";
import Boundary from "./Boundary";
import SourcePicker from "./SourcePicker";
import { getTask, sourceProblem, type TaskId, type LockedTaskId } from "@/lib/tasks";
import Composer, { type Engine, type WriterInfo } from "./Composer";
import Theatre from "./Theatre";
import SetupPanel from "./SetupPanel";
import ShotRow from "./ShotRow";
import { useApi } from "@/lib/useApi";
import { compactTokens } from "@/lib/format";
import { useIsMobile, useSheetLock } from "@/lib/useMobile";
import { useOnChange } from "@/lib/changes";
import { loadDraft, saveDraft, clearDraft } from "@/lib/draft";
import { usePageTitle } from "@/lib/usePageTitle";
import { composePrompt, specCount, type ShotSpec } from "@/lib/studio";
import {
  DEFAULT_MODEL_ID, MODELS, getModel, dimensionsFor,
  estimateCostUsd, estimateTokens, estimateImageCostUsd,
} from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { stillToolModel } from "@/lib/stillTools";
import { useMoney } from "@/lib/price";

export type Params = {
  modelId: string; ratio: string; resolution: string; duration: number;
  watermark: boolean; generateAudio: boolean; seed: string;
  /** Kling motion control: whom the character faces. */
  orientation: "image" | "video";
  /** Topaz: interpolate to 60 fps. */
  fps60: boolean;
};

const SETUP_KEY = "aw_setup_open";

/** The kind's own default engine: Seedance for video, Nano Banana Pro for stills. */
function defaultModelFor(kind: "video" | "image"): string {
  if (kind === "video") return DEFAULT_MODEL_ID;
  return MODELS.find((m) => m.kind === "image" && !m.hidden)?.id ?? DEFAULT_MODEL_ID;
}

export default function Workspace({ kind = "video" }: { kind?: "video" | "image" }) {
  usePageTitle(kind === "image" ? "Generate · Images" : "Generate · Video");
  const { selection: bin, current, refreshProjects } = useProject();
  const { signedIn, models } = useSession();
  const money = useMoney();
  const prefs = usePrefs();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  /** Artlist-style shot control: one choice per category, appended at submit. */
  const [spec, setSpec] = useState<ShotSpec>({});
  /* The audio desk shows the sound half of this setup back (Sound, Mood,
     Time of day, Titles) without owning it, so the latest spec is left
     where it can peek. */
  useEffect(() => {
    try { window.localStorage.setItem("aw_last_spec", JSON.stringify(spec)); } catch { /* private mode */ }
  }, [spec]);
  /* The production's saved setup (Studio › Save as … setup) opens the
     composer already set — unless a spec was carried in, or one is being
     edited; a saved setup never overwrites work in progress. */
  useEffect(() => {
    if (specCount(spec) > 0) return;
    try {
      const saved = window.localStorage.getItem(`aw_setup_${bin}`);
      if (saved) Promise.resolve().then(() => setSpec(JSON.parse(saved) as ShotSpec));
    } catch { /* private mode */ }
    // The spec is read, not depended on: this runs when the production changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin]);
  /** Which shot this take belongs to — what makes it v3 of SH110. */
  const [shotId, setShotId] = useState<string>("");
  /* Stills only: how many to make from one prompt, and the role each one
     plays on the production — a first frame pinned to the shot, a cast
     still standing for a face or a place, or loose. */
  const [count, setCount] = useState(1);
  const [useAs, setUseAs] = useState<"first" | "cast" | "loose">("loose");
  const [castName, setCastName] = useState("");
  /* On a phone the rail is a sheet, opened from a docked bar that always
     shows the filing target, the first line of the prompt and the price. */
  const mobile = useIsMobile();
  const price = usePrice();
  const [sheetOpen, setSheetOpen] = useState(false);
  useSheetLock(mobile && sheetOpen);
  /** Editing or extending an existing render, rather than making a new one.
   *  Both are LOCKED tasks: the source decides the output's shape. */
  /* A locked task can now be chosen BEFORE its source, so the clip is
     nullable: picking "Seedance 2.5 Edit" puts the composer in edit mode and
     then asks which clip. Both call sites in Composer must handle the gap. */
  const [taskOn, setTaskOn] = useState<{ id: LockedTaskId; gen: Gen | null } | null>(null);
  const [pickingSource, setPickingSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  /* Our own renders used as references. Kept apart from `refs` on purpose:
     a RefItem is an uploads row, and removing one from that strip HARD
     DELETES the upload (References.tsx). A render must never be destroyed by
     being taken off the next prompt. */
  const [ownRefs, setOwnRefs] = useState<Gen[]>([]);
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
  /* Seeded for the KIND, so the server renders the still composer for
     /images rather than the video one the client then swaps out — a flash of
     the wrong controls and the wrong price on a slow connection. */
  const [params, setParams] = useState<Params>(() => ({
    modelId: models?.[kind] ?? defaultModelFor(kind), ratio: "16:9", resolution: kind === "image" ? "2K" : "1080p", duration: 5,
    watermark: false, generateAudio: false, seed: "", orientation: "video", fps60: false,
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
        // A prompt handed over from elsewhere wins; otherwise pick up
        // whatever was being typed here before you left the room.
        const draft = carried ? "" : loadDraft(kind, signedIn);
        Promise.resolve().then(() => {
          if (carried) setPrompt(carried);
          else if (draft) setPrompt(draft);
          if (carriedSpec) {
            try { setSpec(JSON.parse(carriedSpec) as ShotSpec); }
            catch { /* a spec we can't read is one we don't apply */ }
          }
          /* A shot chosen in the Studio's builder files the next take. */
          try {
            const carriedShot = window.localStorage.getItem("aw_compose_shot");
            if (carriedShot) { window.localStorage.removeItem("aw_compose_shot"); setShotId(carriedShot); }
          } catch { /* private mode */ }
          if (setup === "0") setSetupOpen(false);
        });
      } catch { /* private mode — nothing carried, nothing lost */ }
    }
    // The prefs store hydrates with its server fallback and only reads the
    // browser's saved defaults in a later pass, so this has to follow `prefs`
    // rather than run once — until the person touches a control.
    if (touched.current) return;
    // The workspace's Defaults & caps name the engine (they inherit the
    // platform's); the browser keeps resolution, duration and audio.
    const m = getModel(models?.[kind] ?? defaultModelFor(kind));
    setParams((s) => ({
      ...s,
      modelId: m.id,
      resolution: m.resolutions.includes(prefs.resolution) ? prefs.resolution : s.resolution,
      duration: m.durations.includes(prefs.duration) ? prefs.duration : s.duration,
      generateAudio: prefs.audio,
    }));
    /* signedIn belongs here: loadDraft refuses to hand anything back
       without a session, so signing in has to re-run this or the draft
       stays lost until a reload. */
  }, [models, prefs, kind, signedIn]);

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
  /* Five seconds is the right cadence while a render is in flight and far
     too eager when nothing is: a page of sixty rows is tens of kilobytes,
     and every tick re-renders the whole wall. Nothing changes on a quiet
     library except by someone else's hand, which twenty seconds catches
     soon enough. The interval flips the moment anything is queued or
     running, so a render still appears the instant it lands. */
  const [live, setLive] = useState(false);
  const { data, error: feedError, refresh } = useApi<{ generations: Gen[] }>(
    `/api/jobs?limit=60&kind=${kind}${query}`, live ? 4000 : 20000);
  const gens = useMemo(() => {
    const all = data?.generations ?? [];
    return bin === "unfiled" ? all.filter((g) => !g.projectId) : all;
  }, [data, bin]);

  /* Kept in state, not derived inline: the interval feeds the very hook that
     produces `gens`, so reading it directly would be circular. Set off the
     effect body — the same trick the seeding effect above uses — because the
     rule against setting state in an effect cannot see through the await. */
  const anyLive = gens.some((g) => g.status === "queued" || g.status === "running");
  useEffect(() => {
    if (anyLive === live) return;
    Promise.resolve().then(() => setLive(anyLive));
  }, [anyLive, live]);

  // The Clips/Stills filter lives here so the wall and the theatre agree on
  // what "next" means.
  const clips = gens.filter((g) => g.kind !== "image" && g.kind !== "audio").length;
  const sounds = gens.filter((g) => g.kind === "audio").length;
  const mixed = [clips, sounds, gens.length - clips - sounds].filter((n) => n > 0).length > 1;
  const visible = useMemo(
    () => !mixed || filter === "all"
      ? gens
      : gens.filter((g) => (filter === "image" ? g.kind === "image" : filter === "audio" ? g.kind === "audio" : g.kind !== "image" && g.kind !== "audio")),
    [gens, mixed, filter]
  );
  const activeId = selected && visible.some((g) => g.id === selected) ? selected : null;

  const modelDef = getModel(params.modelId);
  const isImage = modelDef.kind === "image";
  // The locked task's source is a reference video the strip cannot see.
  const refProblem = referenceProblem(refs, modelDef, prompt, taskOn?.gen ? 1 : 0);
  const hasVideoInput = refs.some((r) => r.kind === "video");
  const inputSeconds = refs
    .filter((r) => r.kind === "video")
    .reduce((a, r) => a + (r.durationS ?? 0), 0);
  const imageRefCount = refs.filter((r) => r.kind === "image").length;
  /* A task that follows a clip is priced on the clip's length, not the
     duration chip: Topaz and motion control bill per second of the source. */
  const sourceSecs = taskOn?.gen ? Number((taskOn.gen.params as { duration?: number }).duration ?? 0) || 0 : 0;
  const followsSource = Boolean(taskOn && getTask(taskOn.id).forceDuration === "source");
  const promptOptional = Boolean(taskOn && getTask(taskOn.id).promptOptional);
  const billedSecs = followsSource ? sourceSecs : params.duration;
  const est = isImage
    ? estimateImageCostUsd(params.modelId, params.resolution, imageRefCount)
    : estimateCostUsd(
        params.modelId, params.resolution, params.ratio, billedSecs,
        inputSeconds, hasVideoInput,
        { audio: params.generateAudio, task: taskOn?.id, fps60: params.fps60 }
      );
  const estTokens = isImage || modelDef.secondRates
    ? null
    : estimateTokens(params.resolution, params.ratio, params.duration, inputSeconds);
  const dims = isImage ? null : dimensionsFor(params.resolution, params.ratio);

  function afterChange() { refresh(); refreshProjects(); }
  // Renames, moves and deletes from the right-click menu land at once.
  useOnChange(afterChange);

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
    if (!(prompt.trim() || promptOptional) || busy || refProblem) return;
    setBusy(true); setErr(null);
    try {
      const payload = JSON.stringify({
          prompt: composePrompt(prompt, spec),
          useAs: isImage ? useAs : undefined,
          castName: isImage && useAs === "cast" ? castName.replace(/^@/, "").trim() || undefined : undefined,
          model: params.modelId, ratio: params.ratio,
          resolution: params.resolution, duration: params.duration,
          watermark: params.watermark, generateAudio: params.generateAudio,
          seed: params.seed || null,
          characterOrientation: params.orientation, fps60: params.fps60,
          projectId: bin !== "all" && bin !== "unfiled" ? bin : null,
          task: taskOn?.id ?? "generate",
          sourceGenId: taskOn?.gen?.id ?? null,
          shotId: shotId || null,
          shotSpec: spec,
          references: [
            ...refs.map((r) => ({ uploadId: r.id, role: r.role })),
            ...ownRefs.map((g) => ({ genId: g.id, role: "reference_image" as const })),
          ],
      });
      /* Stills can go out as a batch of N: N rows, N prices, one press. A
         clip is always one. */
      const n = isImage ? count : 1;
      let json: { id?: string; notices?: string[]; error?: string; held?: boolean; why?: string } = {};
      for (let i = 0; i < n; i++) {
        const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
        json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Submit failed");
      }
      // Only now: a failed submit keeps the words, which is when they matter most.
      clearDraft(kind);
      setPrompt("");
      setOwnRefs([]);
      setRefs([]);
      setTaskOn(null);
      if (Array.isArray(json?.notices) && json.notices.length) {
        await appAlert(json.held ? (json.why === "slots" ? "Waiting" : "Held") : "Sent", json.notices.join("\n\n"));
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
        !(await appConfirm("Replace the composer?", "This take's prompt will replace what you've typed.", { confirmLabel: "Replace" }))) return;
    // Hand back what was typed — cast names, not the @ImageN they became.
    const typed = (gen.params as { rawPrompt?: string }).rawPrompt;
    setPrompt(typed || gen.prompt);
    setSelected(null);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  /** Attach one of ours to the next render, without leaving the room. */
  function useAsRef(gen: Gen) {
    setOwnRefs((prev) => (prev.some((g) => g.id === gen.id) ? prev : [...prev, gen]));
    setSelected(null);
  }

  /**
   * Choose an engine and what to do with it, in one act.
   *
   * The model menu is a menu of MODES rather than of engines, because that
   * is how the work begins — you know you are editing before you know which
   * clip. A locked mode leaves the source empty and the banner asks for it.
   */
  /** The words a locked mode opens with: a trigger the vendor reads, or a plain statement of the task. */
  const seedFor = (task: LockedTaskId) =>
    task === "edit" ? "Replace " : task === "extend" ? "Continue from the final frame: "
    : task === "motion" ? "Move like the reference clip" : task === "reframe" ? "" : "Upscale with Topaz Astra";
  function pickMode(modelId: string, task: TaskId) {
    switchModel(modelId);
    if (task === "generate") { setTaskOn(null); return; }
    setTaskOn((prev) => ({ id: task, gen: prev?.gen ?? null }));
    setPrompt((v) => v.trim() ? v : seedFor(task));
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  /** From the theatre: the same mode, with the clip already known. The
   *  engine follows the task — Seedance edits and extends, Kling moves,
   *  Topaz upscales — unless the current one already offers it. */
  /** A still post tool from the theatre: the price first, then a take under the same shot. */
  async function stillTool(tool: "outpaint" | "cutout", gen: Gen, ratio?: string) {
    const model = stillToolModel(tool);
    const usd = estimateImageCostUsd(model.id, "adaptive", 0)?.net ?? 0;
    const what = tool === "outpaint" ? `Outpaint to ${ratio ?? "9:16"}` : "Cut out the subject";
    const ok = await appConfirm(`${what} for ${money.price(usd, model.id)}?`, "A new take, filed under the same shot.");
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        prompt: "", model: model.id, ratio: ratio ?? "adaptive", resolution: "adaptive", task: "generate",
        projectId: gen.projectId ?? (bin !== "all" && bin !== "unfiled" ? bin : null), shotId: gen.shotId ?? null,
        references: [{ genId: gen.id, role: "reference_image", kind: "image" }],
      }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `The server answered ${res.status}.`);
      afterChange();
    } catch (e) { await appAlert("Not started", (e as Error).message); }
    finally { setBusy(false); }
  }

  function editExtend(id: LockedTaskId, gen: Gen) {
    if (isImage || !(modelDef.supportsTasks ?? ["generate"]).includes(id)) {
      const engine = MODELS.find((m) => m.kind === "video" && !m.hidden && (m.supportsTasks ?? []).includes(id));
      switchModel(engine?.id ?? DEFAULT_MODEL_ID);
    }
    setTaskOn({ id, gen });
    // A reframe starts at 9:16: the point is a new aspect, and the source's own would be a no-op.
    if (id === "reframe") setParams((s) => ({ ...s, ratio: "9:16" }));
    setPrompt(seedFor(id));
    setSelected(null);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  /* The production's shots, for the foot's "files as" line: the code and
     the next version number. The rail's filing chip fetches the same list;
     useApi has no cache, so this is one more small request per project
     rather than a shared one — cheap, and honest about what it is. */
  const scopedForShots = bin !== "all" && bin !== "unfiled";
  const { data: shotList } = useApi<{ shots: { id: string; code: string; takes: number }[] }>(
    scopedForShots ? `/api/shots?projectId=${encodeURIComponent(bin)}` : null, 30_000);
  const shotCodeOf = (id: string) => shotList?.shots.find((x) => x.id === id)?.code ?? null;
  const nextVersionOf = (id: string) => (shotList?.shots.find((x) => x.id === id)?.takes ?? 0) + 1;

  const scopeName = bin === "all" ? "All productions" : bin === "unfiled" ? "Unfiled" : current?.name ?? "";
  /* What the take will be called once it lands: the shot code and the next
     version, or "unfiled" when it files against nothing. Read off the shots
     list the rail already fetches, so it costs no extra request. */
  const filedAs = !shotId ? "unfiled"
    : isImage
      ? `${shotCodeOf(shotId) ?? "shot"} · S${nextVersionOf(shotId)}${count > 1 ? `–S${nextVersionOf(shotId) + count - 1}` : ""}`
      : `${shotCodeOf(shotId) ?? "shot"} v${nextVersionOf(shotId)}`;
  const setupCount = specCount(spec) + (shotId ? 1 : 0);

  /* A locked mode is not renderable until it has a clip the vendor accepts.
     Checked here rather than at submit so the button says why. */
  const sourceIssue = !taskOn ? null
    : !taskOn.gen ? `Choose the clip you want to ${taskOn.id === "edit" ? "edit" : taskOn.id === "extend" ? "continue" : taskOn.id === "motion" ? "borrow the movement from" : taskOn.id === "upscale" ? "upscale" : "reframe"}.`
    : (sourceProblem(getTask(taskOn.id), taskOn.gen.params as { resolution?: string; duration?: number })
      ?? (getTask(taskOn.id).needsImage && imageRefCount + ownRefs.filter((g) => g.kind === "image").length === 0
        ? "Attach a still of the character to move — an upload, one of your renders, or a cast member." : null));

  return (
    <div className={`ws ${data && visible.length === 0 ? "is-empty" : ""}`}>
      {/* The wall draws whatever the library holds, including rows made by
          engines that have since been retired. One unreadable row must not
          take the composer down with it. */}
      <Boundary what="The wall" resetKey={bin}>
        <Feed
          gens={gens} visible={visible} activeId={activeId} onOpen={setSelected}
          filter={filter} setFilter={setFilter} scopeName={scopeName}
          projectId={bin} kind={kind}
          problem={data ? null : feedError}
          onChanged={afterChange}
        />
      </Boundary>

      {/* The composer rail: 400px, the panel ground, its own scroll. Head
          carries the filing chip, body the composer and the two blocks it
          carries into every shot, foot the one button that spends. */}
      <div className="dock">
        <button type="button" className="dock-preview" onClick={() => setSheetOpen(true)}>
          <span className="dock-eyebrow">COMPOSER · FILES AS {filedAs.toUpperCase()}</span>
          <span className="dock-line">{prompt.trim() || (isImage ? "Describe the still…" : "Describe the shot…")}</span>
        </button>
        <button type="button" className="dock-go" onClick={render}
          disabled={busy || !(prompt.trim() || promptOptional) || !signedIn || Boolean(refProblem || sourceIssue)}>
          <span>{busy ? "…" : "Generate"}</span>
          <span className="dock-cost">{est ? price(est.net * (isImage ? count : 1), params.modelId) : "—"}</span>
        </button>
      </div>
      {mobile && sheetOpen && <div className="sheet-scrim" onClick={() => setSheetOpen(false)} />}
      <aside className={`ws-rail ${mobile ? (sheetOpen ? "is-sheet" : "is-hidden") : ""}`}>
        <div className="sheet-grab" aria-hidden="true"><span /></div>
        <div className="ws-rail-head">
          <span className="ws-bar-h">Composer</span>
          <ShotRow chip projectId={bin} shotId={shotId} setShotId={setShotId} />
          {mobile && <button type="button" className="btn-secondary !h-8 !px-2.5 !text-[12px] ml-auto" onClick={() => setSheetOpen(false)}>Close</button>}
        </div>
        <div className="ws-rail-body" ref={islandRef}>
          <Composer
            rail
            prompt={prompt}
            setPrompt={(v) => { setPrompt(v); saveDraft(kind, v); if (err) setErr(null); }}
            promptRef={promptRef}
            params={params} patch={patch}
            model={modelDef} engines={engines} writer={writer}
            refs={refs} setRefs={setRefs} picker={picker} cite={cite}
            taskOn={taskOn} cancelTask={() => setTaskOn(null)}
            problem={signedIn ? (refProblem ?? sourceIssue ?? err)
              : "Sign in to generate. Everything else here is yours to look at."}
            blocked={!signedIn || Boolean(refProblem || sourceIssue)}
            notice={!signedIn}
            est={est} estTokens={estTokens} dims={dims}
            inputSeconds={inputSeconds} hasVideoInput={hasVideoInput} imageRefCount={imageRefCount}
            busy={busy} onRender={render}
            setupCount={setupCount} setupOpen={setupOpen} toggleSetup={toggleSetup}
            kind={kind}
            pickMode={pickMode}
            onPickSource={() => setPickingSource(true)}
            ownRefs={ownRefs}
            dropOwnRef={(id) => setOwnRefs((prev) => prev.filter((g) => g.id !== id))}
            onDropAsset={useAsRef}
          />
          {isImage && (
            <div className="rail-sec">
              <div className="rail-chips">
                <label className="chip-dd" title="How many stills to make from this prompt">
                  ×<select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many stills">
                    {[1, 2, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select><span className="hdr-caret" aria-hidden="true">▼</span>
                </label>
              </div>
              <span className="mono">Use as</span>
              <div className="seg is-fill" role="tablist" aria-label="Use as">
                {([["first", "First frame"], ["cast", "Cast still"], ["loose", "Loose"]] as const).map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={useAs === k}
                    className={`seg-opt ${useAs === k ? "is-on" : ""}`} onClick={() => setUseAs(k)}>{label}</button>
                ))}
              </div>
              {useAs === "cast" && (
                <label className="search">
                  <span className="search-glyph" aria-hidden="true">@</span>
                  <input value={castName} onChange={(e) => setCastName(e.target.value)} placeholder="Who or what it stands for, e.g. Cass" />
                </label>
              )}
              <span className="rail-help">
                {useAs === "first"
                  ? `A first frame is pinned to the shot and offered in the video composer${shotId ? ` for ${shotCodeOf(shotId) ?? "it"}` : ""}.`
                  : useAs === "cast"
                    ? "A cast still stands for a face, a place or a prop, and rides along as a reference wherever its @name is written."
                    : "A loose still belongs to the production and nothing more — a test, a scout, a look."}
              </span>
            </div>
          )}
          <SetupPanel projectId={bin} spec={spec} onCite={cite} />
        </div>
        <div className="ws-rail-foot">
          {/* The cost is on the action, always: quoted before the button is
              enabled, printed on it in mono, never beside it. */}
          <button type="button" onClick={render}
            disabled={busy || !(prompt.trim() || promptOptional) || !signedIn || Boolean(refProblem || sourceIssue)}
            className="btn-primary !h-[46px] !rounded-[8px] !px-4 !text-[14px]" title="Render  ⌘↵">
            <span>{busy ? "Generating…" : isImage ? (count > 1 ? `Generate ${count} stills` : "Generate still") : "Generate"}</span>
            <span className="btn-primary-cost">
              {est
                ? isImage && count > 1 ? `${price(est.net * count, params.modelId)} · ${count} × ${price(est.net, params.modelId)}` : price(est.net, params.modelId)
                : "—"}{!isImage && estTokens != null ? ` · ${compactTokens(estTokens)} TOK` : ""}
            </span>
          </button>
          <span className="mono-s text-center" style={{ letterSpacing: 0 }}>
            files as {filedAs} · {modelDef.label}{isImage ? ` · ${params.resolution.toUpperCase()}` : ` · ${params.duration}s · ${params.resolution.toUpperCase()}`}
          </span>
        </div>
      </aside>

      <Boundary what="This take">
        {pickingSource && taskOn && (
        <SourcePicker
          task={taskOn.id}
          onPick={(gen) => setTaskOn((prev) => (prev ? { ...prev, gen } : { id: "edit", gen }))}
          onClose={() => setPickingSource(false)}
        />
      )}

      <Theatre
          gens={visible} activeId={activeId}
          onClose={() => setSelected(null)} onSelect={setSelected}
          onChanged={afterChange} onUse={useGen} onUseAsRef={useAsRef} onEditExtend={editExtend} onStillTool={stillTool}
        />
      </Boundary>
    </div>
  );
}
