"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { failureLine } from "@/lib/errors";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { dropToIds, isDroppable, readDrop } from "@/lib/drop";
import { createPortal } from "react-dom";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { resolveGenInput } from "@/lib/genAssetInput";
import { DEFAULT_ENHANCER, ENHANCER_LABEL, isRawPrompt, type EnhanceMode } from "@/lib/shell/enhancer";
import { displayModelName } from "@/lib/models";
import { useGenPresetInbox } from "@/lib/shell/gen-preset";
import { cites, nearestSetting, recipeChips, referenceTags, retagRecipe, type GenPreset, type RecipeReference } from "@/lib/shell/recipe";
import { sendReference, useReferenceInbox } from "@/lib/shell/reference-inbox";
import { SAY, referenceRole } from "@/lib/shell/assets";
import { useRecreate } from "@/lib/shell/use-asset-actions";
import { buttonFigure, figureWords, hiddenInMake, makeFigure, type MakeFigure } from "@/lib/shell/make-price";
import { RECENT_CHIPS, askAgain, againAsk, canAgain, recentEmpty, recentEntries, recentMeta, type AgainPrice, type RecentChip } from "@/lib/shell/make-recent";
import { MakeFigureView, useFigureTitle } from "./MakeFigure";
import { useShell } from "@/lib/shell/state";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import type { Project } from "@/lib/workbench/studio";
import { AUDIO_SECONDS, COMPOSER_TYPES, EMPTY_PROMPT, READING_MODELS, TAKES_MAX, draftOffered, soundOffered, stepAudioSeconds, type ComposerModel, type ComposerState, type ComposerType } from "@/lib/workspace/composer";
import { EMPTY_MEMORY, needsPricedRead, rateQuery, readPickerMemory, recentKey, recentModels, rememberRecent, rowPrice, sheetRatesFrom, writePickerMemory, type PickerMemory, type PriceAt, type SheetRates } from "@/lib/workspace/model-picker";
import { ModelSheet } from "./ModelSheet";
import { SeedanceEditHost } from "./tools/SeedanceEditHost";
import { entryBatch, entryDraft, libraryView, type LibraryEntry, type ProjectLibrary } from "@/lib/workspace/library";
import { groupTakes, stripLabel, takeLabel, isVariation, type TakeCell } from "@/lib/variations";
import { LoadBanner, TakeSkeletons, TakeTile } from "./TakeTile";
import { TakeStrip } from "./TakeStrip";
import { DraftStrip } from "./DraftFinal";
import { useWorkspace } from "@/lib/workspace/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import { useComposer, type BatchView } from "@/lib/workspace/use-composer";
import { VirtualItems, smoothScrollIntoView } from "@/components/workspace/VirtualItems";
import { resumeLine, resumePhase, shortName } from "@/lib/higgsfield-consumer/resume";
import { useResumedConnectedJobs } from "@/lib/shell/use-resumed-jobs";
import { dismissable, useClock } from "./ResumedJobs";
import Boundary from "@/components/Boundary";
import { PanelFault, TileFault } from "./PanelFault";
import { cleanSetup, composeForSend, recipeSetup, recoverSetup, withoutSetup, type FilmSetup } from "@/lib/workspace/film-vocabulary";
import { CINEMA_BANK, recipeCinema } from "@/lib/workspace/cinema-vocabulary";
import { cleanCinemaControls, isCinemaStudioAudioMime, isCinemaStudioModel } from "@/lib/cinemaStudioTypes";
import type { GenInputAsset } from "@/lib/genAssetInput";
import { FilmChips, useFilmTypeahead } from "./FilmVocabulary";
import { Glyph, type GlyphName } from "./icons";
import { ViralTool, toolName } from "./viral/ViralView";
import { isMakeTool, makeType, wantsChange, type MakeTool } from "@/lib/shell/make";
import { useNewInterface } from "@/lib/shell/new-interface";
import { Make, type MakeProps } from "./make/Make";

const TYPE_TAB: Record<ComposerType, string> = { video: "Video", image: "Images", audio: "Audio" };
const ORDER: ComposerType[] = ["video", "image", "audio"];
const PLACEHOLDER: Record<ComposerType, string> = {
  video: "Describe the shot: subject, setting, action. # picks a setup; @name cites a reference; raw: nothing is rewritten.",
  image: "Describe the frame: subject, setting, medium. # picks a setup; @name cites a reference; raw: nothing is rewritten.",
  audio: "Describe the sound, the voice or the music: source, setting, pace, texture.",
};
/* What the model sheet lists: engines on this workspace's credits (API-key and direct engines only). */
const CATALOGUE = "Studio engines";
const RING: Record<string, string> = { blue: "var(--gx-accent)", amber: "var(--gx-waiting)", red: "var(--gx-failed)", green: "var(--gx-done)", idle: "var(--gx-idle)" };
/* The quick tools under Make (README § 3.2; the master's row): Social's two, each a mode of this panel. */
const QUICK_TOOLS: { tool: MakeTool; glyph: GlyphName }[] = [{ tool: "motion", glyph: "video" }, { tool: "swap", glyph: "swap" }];
const takeName = (job: ConnectedJob) => shortName(job.input.prompt, 60) || `${job.model.name} take`;
/** A sound Cinema Studio can take as a reference: a WAV uploaded to this workspace (the provider documents WAV; generated sounds are MP3). */
const cinemaSound = (asset: Pick<GenInputAsset, "kind" | "origin" | "mime">) => asset.kind === "audio" && asset.origin === "upload" && isCinemaStudioAudioMime(asset.mime);
const CINEMA_SOUND_ONLY = "Cinema Studio takes sound references as WAV files uploaded to this workspace.";
/** What a batch's takes that went were approved at, in this workspace's credits. */
const approvedTotal = (batch: BatchView) => {
  const went = batch.takes.filter((take) => take.state !== "refused" && take.state !== "not-sent");
  if (!went.length) return null;
  return `${went.reduce((sum, take) => sum + take.credits, 0).toLocaleString("en-US")} cr`;
};
/** A landed batch's settled cost, when every take of it is billed in this workspace's credits. */
const settledTotal = (entries: readonly LibraryEntry[]) =>
  entries.every((entry) => typeof entry.take.credits === "number") ? `${entries.reduce((sum, entry) => sum + (entry.take.credits ?? 0), 0).toLocaleString("en-US")} cr settled` : null;
/** A reference the recreated take cited that Gen does not carry: gone from this workspace, or not a picture or a video. */
type MissingReference = { tag: string | null; kind: string; origin: RecipeReference["origin"]; gone: boolean; reason: string };
type RecipeCard = {
  preset: GenPreset;
  /** The composer, and the Auto switch when the recipe moved it, exactly as they were (Undo). */
  previous: ComposerState;
  autoBefore: boolean | null;
  epoch: number;
  /** × hides the card; a recipe still being read keeps Generate waiting all the same. */
  hidden?: boolean;
  refs: {
    total: number; reading: boolean; missing: MissingReference[];
    /** References still here whose citation moved because one before them is gone. */
    renumbered: { name: string; was: string; now: string }[];
    /** A first or last frame that will be sent as a plain reference. */
    frames: boolean;
  };
};

/**
 * What sits under a Recent card's name ("Make frames" 4): the engine by its whole name and what it was made at, the figure it
 * settled at ("Nano Banana 2 · 1 cr"), then Again with the live price of running it again and Use as reference. Again puts the
 * recipe back in Make to be priced there; it is the price of that run, read from the server for the take's own settings, and
 * pressing it spends nothing (Make's button does). A failed take's Again is Retry, the paid re-render.
 */
function RecentFoot({ entry, models, aspect, fetcher, prices, onAgain, onReference }: {
  entry: LibraryEntry; models: readonly ComposerModel[]; aspect: string | null;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  prices: { current: Map<string, Promise<AgainPrice | null>> };
  onAgain: (entry: LibraryEntry) => void; onReference: (entry: LibraryEntry) => void;
}) {
  const ask = useMemo(() => againAsk(entry, models, aspect), [entry, models, aspect]);
  const askKey = ask?.key ?? null;
  const [answer, setAnswer] = useState<{ key: string; price: AgainPrice | null } | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    let pending = prices.current.get(ask.key);
    if (!pending) {
      const asked = ask;
      const made = askAgain(asked, fetcher).catch(() => null);
      pending = made;
      prices.current.set(asked.key, made);
      /* A read that came back with no figure is asked again next time, not remembered as "no price". */
      void made.then((value) => { if (value === null && prices.current.get(asked.key) === made) prices.current.delete(asked.key); });
    }
    void pending.then((price) => { if (live) setAnswer({ key: ask.key, price }); });
    return () => { live = false; };
    // The key names every input the read prices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, fetcher, prices]);
  const price = answer && answer.key === askKey ? answer.price : null;
  const again = price ? makeFigure(price.credits, price.approximate) : null;
  const againTitle = useFigureTitle(again);
  const settled = entry.take.credits;
  const shown = settled != null && settled > 0 ? makeFigure(settled) : null;
  const referable = referenceRole(entry.media) !== null;
  const rerun = canAgain(entry);
  const word = entry.take.status === "failed" ? "Retry" : "Again";
  return (
    <>
      <span className="gx-make-card-line" data-testid="make-take-meta">{recentMeta(entry)}{shown ? <> · <MakeFigureView figure={shown} /></> : null}</span>
      {rerun || referable ? (
        <span className="gx-make-card-actions">
          {rerun ? (
            <button type="button" className="gx-hbtn" onClick={() => onAgain(entry)} disabled={!again} title={again ? againTitle : "No price yet"} data-testid="make-again" data-priced={again ? "" : undefined}
              data-spend={again ? "priced" : "unpriced"} aria-label={again ? `${word} · ${figureWords(again)}` : word}>
              <span>{word}{again ? <> · <MakeFigureView figure={again} /></> : null}</span>
            </button>
          ) : null}
          {referable ? <button type="button" className="gx-hbtn" onClick={() => onReference(entry)} data-testid="make-use-reference">Use as reference</button> : null}
        </span>
      ) : null}
    </>
  );
}

/**
 * Make (design/particl-graphite/README.md § 3.2): a 440 px panel over any
 * screen — full width on a phone — that was the Gen page. Its Make tab is the
 * composer the handoff draws (type, words, references, the engine line with
 * its live price and Change, Make at that price, where it goes), then every
 * control the handoff's panel does not draw yet, exactly as Gen had them, in
 * Gen's order. Its Recent tab is Gen's results. Its models are Studio engines
 * on this workspace's credits. Its quick tools (`make=motion|swap`) are
 * Motion transfer and Object swap, drawn by ViralTool in the same panel while
 * the composer keeps its draft. Takes an earlier visit left running on a
 * signed-in account are still shown until they land (the shell's collector
 * files them); nothing new starts there.
 */
function MakePanelToday({ scope, project, items, library, projects = "ready", projectsError = null, onRetry, workspaceName, onProject, beside = false, aspect = null }: {
  scope: string; project: Project | null; items: LibraryEntry[];
  /** The open project's library store (its read: skeletons, a failed read's banner); `projects` is the project list's own read. */
  library: ProjectLibrary; projects?: "loading" | "ready" | "error";
  /** The project list failed to read: said here too, with Try again, and the draft stays editable. */
  projectsError?: string | null; onRetry?: () => void;
  workspaceName: string | null; onProject: (id: string) => void;
  /** The workspace's credit balance (account.credits.balance), for "Short by N cr"; null while unknown. Passed by the shell; Make reads it. */
  balance?: number | null;
  /** The Inspector's column is open on a take (one opened from Recent): Make sits beside it rather than over it. */
  beside?: boolean;
  /** The project's frame, so every card and skeleton on Recent holds it (the card contract, TakeTile.tsx). */
  aspect?: string | null;
}) {
  const shell = useShell();
  const ws = useWorkspace();
  const opened = makeType(shell.make) ?? shell.lastMake;
  /* A quick tool is drawn instead of the composer, which stays mounted under it and keeps its draft. */
  const tool = isMakeTool(shell.make) ? shell.make : null;
  const [initialType] = useState(opened);
  const composer = useComposer({ scope, open: true, project, projects, onProject, workspaceName, initialType, compose: composeForSend, verb: "Make", hide: hiddenInMake });
  const { state, model, offered, settings, blocked: waiting, buttonParts, submitting } = composer;
  /* Make's own words for an empty prompt; every other reason is the composer's. */
  const blocked = waiting === EMPTY_PROMPT ? "Say what to make." : waiting;
  const recentTab = shell.make === "recent";
  /* The panel starts under the header, whatever height the header has on this screen. */
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = panel.current, root = el?.closest<HTMLElement>(".gx"), header = root?.querySelector<HTMLElement>(".gx-header");
    if (!el || !root || !header) return;
    /* On the shell's root, so the engine sheet (portalled there) lines up with the panel too. */
    const place = () => root.style.setProperty("--make-top", `${Math.max(0, Math.round(header.getBoundingClientRect().bottom - root.getBoundingClientRect().top))}px`);
    place();
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    watch?.observe(header); watch?.observe(root);
    return () => { watch?.disconnect(); root.style.removeProperty("--make-top"); };
  }, []);
  /* Cinema Studio 4.0 on this workspace's credits: its own documented controls under Direction (sent as its parameters,
     never written into the words) and WAV sound references in the well. */
  const cinemaModel = model != null && isCinemaStudioModel(model.id);
  const dispatchComposer = composer.dispatch;
  const [mode, setMode] = useState<"compose" | "edit">("compose");
  const dispatchType = useCallback((value: ComposerType) => { setMode("compose"); dispatchComposer({ type: "type", value }); }, [dispatchComposer]);
  /* The address and the composer name one type: a type the address moved to (a link, an Open, Back) is the composer's,
     and a type the composer moved to (a tab here, a recipe) is the address's. Each follows only the other's change. */
  const { setMake } = shell;
  const asked = shell.make;
  const follow = useRef({ dispatchType, setMake });
  useEffect(() => { follow.current = { dispatchType, setMake }; });
  const synced = useRef({ asked, type: state.type });
  useEffect(() => {
    const was = synced.current;
    synced.current = { asked, type: state.type };
    if (!asked || asked === "recent" || isMakeTool(asked) || asked === state.type) return;
    if (asked !== was.asked) follow.current.dispatchType(asked);
    else if (state.type !== was.type) follow.current.setMake(state.type);
  }, [asked, state.type]);
  const scopedFetch = useScopedFetch(scope);
  /* What an Again costs, asked of the server once per recipe while this panel is open (Recent's cards read it; nothing here quotes a send). */
  const againPrices = useRef(new Map<string, Promise<AgainPrice | null>>());
  const recreate = useRecreate();
  const [sheet, setSheet] = useState(false);
  /* What this browser remembers for the sheet (recent picks), read fresh each time it opens. */
  const [memory, setMemory] = useState<PickerMemory>(EMPTY_MEMORY);
  const modelButton = useRef<HTMLButtonElement>(null);
  const openSheet = () => { setMemory(readPickerMemory(scope)); setSheet(true); };
  const closeSheet = () => { setSheet(false); setSheetRates((r) => (r?.failed ? null : r)); modelButton.current?.focus({ preventScroll: true }); };
  const used = (id: string) => writePickerMemory(scope, rememberRecent(readPickerMemory(scope), recentKey(state.type, id)));
  const pickModel = (m: ComposerModel) => { used(m.id); composer.dispatch({ type: "model", value: m.id }); closeSheet(); };
  const recent = useMemo(() => recentModels(memory.recent, state.type, offered), [memory.recent, state.type, offered]);
  /* Every Studio row is priced where the composer stands (its picks, the project's aspect, its references,
     one take, a sound's length in the whole seconds it bills): the list's own rates cover the untouched composer; anything else is one read of the engines
     route's list, priced there, while the sheet is open. It quotes nothing and reserves nothing. */
  const draftTakes = settings.draft ? 1 : state.count;
  const priceAt = useMemo<PriceAt>(() => ({ aspect: composer.project?.aspect, picks: state.picks, references: state.references, seconds: Math.round(state.seconds), takes: draftTakes }),
    [composer.project?.aspect, state.picks, state.references, state.seconds, draftTakes]);
  const priceKey = rateQuery(priceAt);
  const [sheetRates, setSheetRates] = useState<SheetRates | null>(null);
  /* A sound or a piece of music is priced by its length, not its words: before any are typed its price is the rate list's, read
     here once (the same read the sheet makes), so the button and the engine line carry a price from the start. Speech is priced by
     its words and shows none until there are some. */
  const idleSound = state.type === "audio" && !state.prompt.trim() && (model?.audioTask === "sound" || model?.audioTask === "music");
  const wantsRates = (sheet && needsPricedRead(offered, priceAt)) || idleSound;
  const ratesKey = sheetRates?.key ?? null;
  useEffect(() => {
    if (!wantsRates || ratesKey === priceKey) return;
    let live = true;
    void scopedFetch(`/api/workbench/engines?${priceKey}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error("unpriced"); return r.json(); })
      .then((reply) => { if (live) setSheetRates(sheetRatesFrom(priceKey, reply)); })
      /* An unread price leaves those rows "quoted"; the next opening asks again. */
      .catch(() => { if (live) setSheetRates({ key: priceKey, models: {}, audio: null, failed: true }); });
    return () => { live = false; };
  }, [wantsRates, ratesKey, priceKey, scopedFetch]);
  const rates = sheetRates?.key === priceKey ? sheetRates : null;
  const readingRates = wantsRates && !rates;
  const priceOf = (m: ComposerModel) => rowPrice(m, null, priceAt, rates, readingRates);
  const takesCount = settings.draft ? 1 : Math.max(1, state.count);
  const idleRate = idleSound && rates ? (model?.audioTask === "sound" ? rates.audio?.sound : rates.audio?.music) ?? null : null;
  const idleOne = idleRate && (idleRate.seconds == null || idleRate.seconds === composer.seconds) ? idleRate.credits : null;
  const [wellError, setWellError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState<RecentChip>("All");
  const anchored = state.references.some((r) => r.kind === "video") || (state.type === "video" && state.references.length > 0);
  const enhancer = useEnhancer({
    prompt: state.prompt, mode: state.type as EnhanceMode, model: model?.id ?? null,
    anchored, editing: state.type === "image" && state.references.length > 0,
  });

  const drop = useCallback(async (id: string) => {
    setWellError(null);
    try {
      const asset = await resolveGenInput(id, scope);
      if (asset.kind === "audio" && cinemaModel) {
        if (!cinemaSound(asset)) throw new Error(CINEMA_SOUND_ONLY);
        dispatchComposer({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: "audio", name: asset.name, url: asset.url } });
        return;
      }
      if (asset.kind !== "image" && asset.kind !== "video") throw new Error(cinemaModel ? "References are images, videos and WAV sounds." : "References are images and videos.");
      dispatchComposer({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url } });
    } catch (error) {
      setWellError(error instanceof Error ? error.message : "This file cannot be used as a reference.");
    }
  }, [scope, dispatchComposer, cinemaModel]);

  /* What is handed over from elsewhere in the shell arrives by letter (lib/shell/gen-preset.ts): a Gen
     that is already open takes it at once — ⌘R included — and nothing lingers to be applied again. Crew ›
     Open in Gen, a model picked in ⌘K and the public site's hero hand over words, a model and settings:
     the kind, the model, the words (an empty prompt leaves the composer's own), the settings and the sound. Recreate hands
     over a take's whole recipe, applied in one step that Undo reverses. Nothing runs either way: the
     button prices what arrived. */
  const [recipe, setRecipe] = useState<RecipeCard | null>(null);
  const [preset, setPreset] = useState<GenPreset | null>(null);
  const recipeEpoch = useRef(0);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  const { dismiss: dismissEnhanced, setAuto } = enhancer;
  const applyPreset = useCallback((next: GenPreset) => {
    setMode("compose");
    setWellError(null);
    if (!next.from) {
      /* New words replace the old, an enhancement of them and any recipe that brought them. A model or
         settings alone are a change made here: a recipe's card stays, says so, and still waits for its references. */
      if (next.prompt) { recipeEpoch.current++; dismissEnhanced(); setRecipe(null); }
      if (next.type) dispatchComposer({ type: "type", value: next.type });
      if (next.model) dispatchComposer({ type: "model", value: next.model });
      if (next.prompt) dispatchComposer({ type: "prompt", value: next.prompt });
      if (next.picks) dispatchComposer({ type: "pick", value: next.picks });
      if (next.sound?.seconds) dispatchComposer({ type: "seconds", value: next.sound.seconds });
      if (next.sound?.instrumental !== undefined) dispatchComposer({ type: "instrumental", value: next.sound.instrumental });
      if (next.sound?.voiceId) dispatchComposer({ type: "voice", value: next.sound.voiceId });
      setPreset(next);
      return;
    }
    const epoch = ++recipeEpoch.current;
    /* New words replace the old: an enhancement of the old words must not be what Generate sends. */
    if (!next.settingsOnly) dismissEnhanced();
    const previous = latest.current;
    const settingsOnly = Boolean(next.settingsOnly);
    const type = next.type ?? previous.type;
    const refs = settingsOnly || type === "audio" ? [] : next.references ?? [];
    /* Every take recreates on this workspace's engines: one made on the account's catalogue keeps
       its words and settings, and the engine choice here stands. */
    const lost = next.billing === "connected";
    /* The shot setup lands on the chips, and comes back out of the words it was written into. A take that keeps
       none as data (the connected account stores only words) is read for one written in the bank's way. */
    const kept = cleanSetup(next.shotSpec);
    const found = Object.keys(kept).length ? null : recoverSetup(next.prompt, type);
    const shot = found?.setup ?? kept;
    const taken = found ? { ...next, shotSpec: found.setup } : next;
    /* A Cinema Studio take's controls land on its chips; its WAV sound references come back with it. */
    const onCinema = !lost && Boolean(next.model && isCinemaStudioModel(next.model));
    const cinema = cleanCinemaControls(next.cinema);
    dispatchComposer({
      type: "recipe",
      value: {
        type, billing: "workspace", picks: next.picks ?? {}, sound: next.sound, shot, cinema,
        ...(lost ? {} : { model: next.model }),
        ...(settingsOnly ? {} : { prompt: found ? found.words : withoutSetup(next.prompt, shot), references: [] }),
      },
    });
    setPreset(null);
    setRecipe({ preset: taken, previous, autoBefore: null, epoch, refs: { total: refs.length, reading: refs.length > 0, missing: [], renumbered: [], frames: false } });
    if (!refs.length) return;
    /* Every reference is read again in this workspace. The ones still here keep the take's order; the words
       are renumbered to match them, and the ones that are gone keep citations of their own (recipe › retagRecipe). */
    void Promise.allSettled(refs.map((r) => resolveGenInput(`${r.origin}:${r.id}`, scope))).then((results) => {
      if (recipeEpoch.current !== epoch) return;
      const assets = results.map((result) => (result.status === "fulfilled" ? result.value : null));
      const usable = assets.map((asset) => (asset && (asset.kind === "image" || asset.kind === "video") ? { ...asset, kind: asset.kind }
        : asset && onCinema && cinemaSound(asset) ? { ...asset, kind: "audio" as const } : null));
      const kinds = refs.map((r, i) => (r.kind ?? assets[i]?.kind ?? "image"));
      const tags = retagRecipe(latest.current.prompt, kinds.map((kind, i) => ({ kind, found: Boolean(usable[i]) })));
      const missing: MissingReference[] = [];
      const renumbered: RecipeCard["refs"]["renumbered"] = [];
      usable.forEach((asset, i) => {
        const r = refs[i];
        if (asset) {
          dispatchComposer({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url, ...(r.role ? { role: r.role } : {}) } });
          if (tags.was[i] && tags.now[i] && tags.was[i] !== tags.now[i] && cites(tags.prompt, tags.now[i]!)) renumbered.push({ name: asset.name, was: tags.was[i]!, now: tags.now[i]! });
          return;
        }
        const result = results[i];
        missing.push(assets[i]
          ? { tag: null, kind: assets[i]!.kind, origin: r.origin, gone: false, reason: assets[i]!.kind === "audio" && onCinema ? CINEMA_SOUND_ONLY : "References are images and videos." }
          : { tag: tags.now[i], kind: kinds[i], origin: r.origin, gone: true, reason: result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "Not found in this workspace." });
      });
      if (tags.prompt !== latest.current.prompt) dispatchComposer({ type: "prompt", value: tags.prompt });
      /* A first or last frame is sent as a plain reference (the composer's roles come from the kind). */
      const frames = usable.some((asset, i) => asset && /first_frame|last_frame/.test(refs[i].role ?? ""));
      setRecipe((now) => (now?.epoch === epoch ? { ...now, refs: { total: refs.length, reading: false, missing, renumbered, frames } } : now));
    });
  }, [scope, dispatchComposer, dismissEnhanced]);
  useGenPresetInbox(applyPreset);
  /* The engine a preset named may not be on offer here any more: say which one stands in (a recipe's card says it for Recreate). */
  const presetNote = !preset?.note ? null
    : preset.model && model && composer.models.length && model.id !== preset.model ? `${preset.note} · ${displayModelName(preset.model)} is not offered here; ${model.label} is selected` : preset.note;
  const undoRecipe = () => {
    if (!recipe) return;
    recipeEpoch.current++;
    dispatchComposer({ type: "restore", value: recipe.previous });
    dismissEnhanced();
    if (recipe.autoBefore !== null) setAuto(recipe.autoBefore);
    setRecipe(null);
    /* A model or settings handed over since are undone with it, and so is their note. */
    setPreset(null);
  };
  /* The card comes into view where the composer is. On a phone it rises to the top of the page, clear of
     the sticky Generate band and the tab bar below it; wider, the least scroll that shows it. */
  const recipeCard = useRef<HTMLDivElement>(null);
  const shownEpoch = recipe?.epoch ?? 0;
  useEffect(() => {
    if (!shownEpoch) return;
    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
    recipeCard.current?.scrollIntoView({ block: phone ? "start" : "nearest" });
  }, [shownEpoch]);
  /* A size or length the model Gen holds does not offer lands on the nearest it does (never above the take's),
     not on the list's first. Only the recipe's own value moves: once the person picks, theirs stands. */
  const wantedSize = recipe?.preset.picks?.resolution;
  const wantedSeconds = recipe?.preset.picks?.duration;
  const heldSize = state.picks.resolution;
  const heldSeconds = state.picks.duration;
  const sizes = model?.resolutions;
  const lengths = model?.durations;
  useEffect(() => {
    const size = wantedSize && heldSize === wantedSize && sizes ? nearestSetting(wantedSize, sizes) : undefined;
    const seconds = wantedSeconds && heldSeconds === wantedSeconds && lengths ? nearestSetting(wantedSeconds, lengths) : undefined;
    if (size !== undefined || seconds !== undefined) dispatchComposer({ type: "pick", value: { ...(size !== undefined ? { resolution: size } : {}), ...(seconds !== undefined ? { duration: seconds } : {}) } });
  }, [wantedSize, wantedSeconds, heldSize, heldSeconds, sizes, lengths, dispatchComposer]);
  /* Gen's film vocabulary: the chips under Direction, and `#` in the words. On Cinema Studio 4.0 the same chips,
     grids and `#` offer its own documented controls instead (lib/workspace/cinema-vocabulary.ts). */
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const setShot = useCallback((value: FilmSetup) => dispatchComposer({ type: "shot", value }), [dispatchComposer]);
  const setCinema = useCallback((value: FilmSetup) => dispatchComposer({ type: "cinema", value }), [dispatchComposer]);
  const setPrompt = useCallback((value: string) => dispatchComposer({ type: "prompt", value }), [dispatchComposer]);
  const typeahead = useFilmTypeahead({
    type: state.type, prompt: state.prompt, textarea: promptBox, onPrompt: setPrompt,
    ...(cinemaModel ? { setup: state.cinema, onSetup: setCinema, bank: CINEMA_BANK } : { setup: state.shot, onSetup: setShot }),
  });

  /* The Library's `+`, a right-click or a drop on any page lands here as a reference. */
  const inbox = useCallback((letter: { id: string }) => { void drop(letter.id); }, [drop]);
  /* A quick tool takes the letters while it is open. */
  useReferenceInbox(tool ? null : inbox);
  /* Recent's "Use as reference": the same letter the Library's + sends, so the composer takes it as it takes a drop. Sound takes none,
     so from Audio it comes back to Video first (the references are what the person asked for). */
  const addAsReference = (entry: LibraryEntry) => {
    const role = referenceRole(entry.media);
    if (!role) { ws.toast("References are images and videos."); return; }
    const type = state.type === "audio" ? "video" : state.type;
    if (type !== state.type) dispatchType(type);
    sendReference({ id: entry.take.id, name: entry.take.name });
    setMake(type);
    ws.toast(SAY.referenced(entry.take.name, role));
  };

  /* A recreated take is not sent half-read: while its references are still being read, the composer holds a
     recipe without them, and a price for that is not the take's price. A citation of a reference that is gone
     holds it too, until a reference fills the slot or the words drop it. */
  const orphans = recipe && !recipe.refs.reading
    ? recipe.refs.missing.filter((m) => m.gone && m.tag && cites(state.prompt, m.tag)
      && state.references.filter((r) => r.kind === m.kind).length < Number(m.tag.replace(/\D/g, "")))
    : [];
  const orphan = orphans[0];
  const recipeWait = !recipe ? null
    : recipe.refs.reading ? "Reading the take’s references…"
    : orphan ? `The prompt cites ${orphan.tag}, which is gone. Add a reference or edit the words.`
    : null;
  const block = submitting ? blocked : recipeWait ?? blocked;

  /* Auto: when an enhancement is on the card, it is what gets submitted. */
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    if (!recipeWait) composer.generate();
  }, [state.prompt, composer, recipeWait]);
  const generate = () => {
    if (recipeWait) return;
    /* A take that goes out makes its model a recent one. */
    if (model && !blocked) used(model.id);
    if (enhancer.auto && enhancer.enhanced && enhancer.enhanced !== state.prompt && !isRawPrompt(state.prompt)) {
      pending.current = true;
      composer.dispatch({ type: "prompt", value: enhancer.enhanced });
      enhancer.dismiss();
      return;
    }
    composer.generate();
  };


  /* A batch still being followed is drawn from the composer (below) until it is over; its takes are not drawn twice. */
  const liveBatches = composer.batches;
  const liveIds = useMemo(() => new Set(liveBatches.map((batch) => batch.id)), [liveBatches]);
  /* Recent's chips: All (takes and uploads), Takes, Unfiled (a take on no shot), Filed (on a shot). */
  const results = useMemo(
    () => recentEntries(items, filter).filter((entry) => !liveIds.has(String(entryBatch(entry)?.batchId ?? ""))),
    [items, filter, liveIds]);
  /* Takes 2–4 of one Generate sit together as one strip, in take order; a draft and its final as another (lib/variations.ts). */
  const cells = useMemo(() => groupTakes(results, entryBatch, entryDraft), [results]);
  const byGeneration = useMemo(() => new Map(items.map((entry) => [entry.take.sourceId, entry])), [items]);
  const made = useMemo(() => items.some((entry) => entry.take.kind === "GEN"), [items]);
  const view = libraryView(project ? library.state : null, made ? 1 : 0, projects);
  /* The strip's own run, until the library carries the same take: its own card then says where it is. A batch
     draws its own strip instead of one running card. */
  const running = ws.state.gen && !ws.state.gen.id.startsWith("batch:") && !items.some((entry) => entry.take.sourceId === ws.state.gen?.id) ? ws.state.gen : null;
  /* Takes still on the connected account from an earlier visit, as the shell's collector reads them until
     they land (it announces each one and re-reads the Library). The one the composer is running now is the
     composer's alone. Collection files a take into Takes on the server; nothing here writes the draft. */
  const resumed = useResumedConnectedJobs({
    draftId: project?.id ?? null, owned: [ws.state.gen?.id],
    accept: (job) => job.composer === "gen",
  });
  const pickedUp = resumed.jobs;
  const rendering = pickedUp.filter((item) => item.following).length;
  const clock = useClock(rendering ? 30_000 : 0);
  const resultsRef = useRef<HTMLElement | null>(null);
  /* On a narrow screen the results sit under the whole composer: say at the top that takes are still out. The jump goes
     through smoothScrollIntoView like every smooth move in a scroller that holds a windowed list: today it runs down to
     cards above the grid's rows, and a layout that put rows on its way would otherwise stop it short. */
  const jumpPending = useRef(false);
  const jump = () => smoothScrollIntoView(resultsRef.current?.querySelector<HTMLElement>('[data-testid="gen-resumed"]'), "center");
  /* The takes still out are on Recent: the jump goes there first, then down to them. */
  const jumpToPickedUp = () => { if (recentTab) { jump(); return; } jumpPending.current = true; setMake("recent"); };
  useEffect(() => {
    if (!recentTab || !jumpPending.current) return;
    jumpPending.current = false;
    requestAnimationFrame(() => jump());
  });
  const takesReferences = state.type !== "audio";
  /* The well names each reference the way the engine counts it: @Image1, @Video1, @Audio1, within its own kind. */
  const wellTags = referenceTags(state.references.map((r) => r.kind));
  /* The Direction box takes media: pictures and videos become references when this model takes them (and, on Cinema
     Studio, WAV sounds); the rest stays in the Library. */
  const attachToGen = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const used: string[] = [], kept = [...unreadable];
    for (const m of media) {
      if (takesReferences && (m.kind === "image" || m.kind === "video")) { dispatchComposer({ type: "addReference", value: { key: m.key, id: m.id, origin: m.origin, kind: m.kind, name: m.name, url: m.url } }); used.push(m.name); }
      else if (takesReferences && cinemaModel && cinemaSound(m)) { dispatchComposer({ type: "addReference", value: { key: m.key, id: m.id, origin: m.origin, kind: "audio", name: m.name, url: m.url } }); used.push(m.name); }
      else kept.push(m.name);
    }
    const why = !takesReferences ? `${model?.label ?? "this model"} takes a prompt only.` : cinemaModel ? "references are pictures, video and WAV sounds." : "references are pictures and video.";
    return [used.length ? `${used.join(", ")} ${used.length === 1 ? "is a reference" : "are references"}.` : "", keptNote(kept, why) ?? ""].filter(Boolean).join(" ") || null;
  };
  /* Sound says what it will be: the voice a line is read in, or the length and, for music, whether it has vocals. */
  const soundTask = model?.audioTask === "sound" || model?.audioTask === "music" ? model.audioTask : null;
  const footer = (state.type === "audio"
    ? [model?.audioTask === "speech" ? composer.voice?.name : null, soundTask ? `${composer.seconds} s` : model?.durations?.length ? `${settings.duration} s` : null, soundTask === "music" ? (state.instrumental ? "Instrumental" : "With vocals") : null, "Saved to your takes"]
    : [settings.ratio, model?.durations?.length ? `${settings.duration} s` : null, "Saved to your takes"]).filter(Boolean).join(" · ");
  /* One take's tile — the card contract's (TakeTile) — walled off so a take that throws costs only its own tile; in a strip,
     `label` names it "take N". */
  const tile = (entry: LibraryEntry, label?: string) => (
    <Boundary what="This take" probe={`take:${entry.take.id}`} resetKey={entry.take.id} fallback={(fault) => <TileFault fault={fault} name={entry.take.name} />} key={entry.take.id}>
      <TakeTile entry={entry} variant="grid" label={label} selected={ws.state.selKind === "take" && ws.state.selId === entry.take.id} onRefresh={library.refresh}
        meta={<RecentFoot entry={entry} models={composer.models} aspect={composer.project?.aspect ?? null} fetcher={scopedFetch} prices={againPrices} onAgain={recreate} onReference={addAsReference} />}
        onOpen={() => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); }} />
    </Boundary>
  );
  /* A draft's or its final's card in their strip (components/graphite/DraftFinal.tsx): the card contract's TakeTile, named
     by its role, with its watermark under the name once it has rendered. */
  const pairTile = (entry: LibraryEntry, label: string, note: string | null) => (
    <Boundary what="This take" probe={`take:${entry.take.id}`} resetKey={entry.take.id} fallback={(fault) => <TileFault fault={fault} name={entry.take.name} />} key={entry.take.id}>
      <TakeTile entry={entry} variant="grid" label={label} testId="gen-draft-take" selected={ws.state.selKind === "take" && ws.state.selId === entry.take.id} onRefresh={library.refresh}
        meta={note ? <span data-testid="gen-draft-take-note">{note}</span> : undefined}
        onOpen={() => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); }} />
    </Boundary>
  );
  /* A take's picture: opens it in the Inspector, and drags anywhere a take is taken. */
  const thumb = (entry: LibraryEntry) => (
    <button type="button" className="gx-asset-thumb" title={entry.take.name} draggable data-ctx={`asset:${entry.take.id}`} {...previewAttrs(entryPreview(entry))}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copy"; }}
      onClick={() => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); }}>
      {entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" /> : entry.media === "audio" ? <span className="gx-badge">AUDIO</span> : null}
    </button>
  );

  /* What Gen holds against what the recreated take was made with. */
  const chips = recipe ? recipeChips({
    preset: recipe.preset, type: state.type, billing: "workspace", model, models: composer.models, settings, owner: false,
    reading: blocked === READING_MODELS, blocked: model ? null : blocked, identities: null,
    sound: { seconds: composer.seconds, instrumental: state.instrumental, voice: composer.voice, voices: composer.voices },
  }) : [];
  const refs = recipe?.refs ?? null;
  /* The setup the take carried, and whether the chips still hold it for this output (a still has no camera travel). */
  const setup = recipe?.preset.shotSpec ? recipeSetup(recipe.preset.shotSpec, recipe.preset.type ?? state.type, state.shot, state.type) : null;
  /* A Cinema Studio take's controls, and whether its chips still hold them (they only go with Cinema Studio). */
  const controls = recipe?.preset.cinema ? recipeCinema(recipe.preset.cinema, state.cinema, cinemaModel) : null;
  const carried = refs ? refs.total - refs.missing.length : 0;
  const gone = refs?.missing.filter((m) => m.gone) ?? [];
  const unused = refs?.missing.filter((m) => !m.gone) ?? [];
  const from = (m: MissingReference) => (m.origin === "upload" ? "upload" : "take");
  const notes = recipe && !recipe.hidden ? [
    ...chips.filter((c) => c.state === "changed" && c.why).map((c) => ({ key: c.key, label: c.label, text: c.why!, alert: false })),
    ...(setup?.why && setup.labels.length ? [{ key: "setup", label: "Setup", text: setup.why, alert: false }] : []),
    ...(controls?.why && controls.labels.length ? [{ key: "cinema", label: "Controls", text: controls.why, alert: false }] : []),
    ...(gone.length ? [{ key: "gone", label: "Not found", text: gone.map((m) => `${m.tag ?? "a sound"} (${from(m)})${orphans.includes(m) ? " · still in the prompt" : ""}`).join(", "), alert: true }] : []),
    ...(unused.length ? [{ key: "unused", label: "Not used here", text: unused.map((m) => `${m.kind === "audio" ? "a sound" : "a file"} (${from(m)})`).join(", "), alert: false }] : []),
    ...(refs?.renumbered.length ? [{ key: "renumbered", label: "Renumbered", text: refs.renumbered.map((r) => `${r.name} ${r.was} → ${r.now}`).join(", "), alert: false }] : []),
    ...(refs?.frames ? [{ key: "frames", label: "Frames", text: "Sent as plain references", alert: false }] : []),
  ] : [];
  const recipeCardView = recipe && !recipe.hidden ? (
    <div className="gx-recipe" ref={recipeCard} aria-live="polite" data-testid="gen-recipe" data-settings-only={recipe.preset.settingsOnly ? "true" : undefined}>
      <div className="gx-recipe-head">
        <span className="gx-eyebrow" data-functional-label="">{recipe.preset.settingsOnly ? "Settings from" : "Recreate"}</span>
        <span className="gx-recipe-name" title={recipe.preset.from?.name} data-testid="gen-recipe-name">{recipe.preset.from?.name}</span>
        <button type="button" className="gx-hbtn" onClick={undoRecipe} title="Put the composer back as it was" data-testid="gen-recipe-undo">Undo</button>
        <button type="button" className="gx-ref-x" aria-label="Dismiss" onClick={() => setRecipe((now) => (now ? { ...now, hidden: true } : now))} data-testid="gen-recipe-dismiss">×</button>
      </div>
      <ul className="gx-recipe-chips" aria-label="Carried from the take" data-testid="gen-recipe-chips">
        {chips.map((c) => <li key={c.key} data-state={c.state} data-chip={c.key} title={`${c.label}: ${c.value}${c.why ? ` — ${c.why}` : ""}`}>{c.value}</li>)}
        {refs?.total ? (
          <li data-state={refs.reading ? "reading" : refs.missing.length || refs.frames ? "changed" : "kept"} data-chip="refs" data-testid="gen-recipe-refs">
            {refs.reading ? `${refs.total} ${refs.total === 1 ? "ref" : "refs"}…` : refs.missing.length ? `${carried} of ${refs.total} refs` : `${refs.total} ${refs.total === 1 ? "ref" : "refs"}`}
          </li>
        ) : null}
        {setup?.labels.length ? (
          <li data-state={setup.kept ? "kept" : "changed"} data-chip="setup" data-testid="gen-recipe-setup"
            title={`Setup: ${setup.labels.join(" · ")}${setup.why ? ` — ${setup.why}` : ""}`}>{setup.labels.join(" · ")}</li>
        ) : null}
        {controls?.labels.length ? (
          <li data-state={controls.kept ? "kept" : "changed"} data-chip="cinema" data-testid="gen-recipe-cinema"
            title={`Controls: ${controls.labels.join(" · ")}${controls.why ? ` — ${controls.why}` : ""}`}>{controls.labels.join(" · ")}</li>
        ) : null}
      </ul>
      {notes.length ? (
        <ul className="gx-recipe-why" data-testid="gen-recipe-why">
          {notes.map((n) => (
            <li key={n.key} data-note={n.key} data-alert={n.alert ? "true" : undefined} data-testid={n.key === "gone" ? "gen-recipe-missing" : undefined}
              title={n.key === "gone" ? gone.map((m) => m.reason).join(" ") : undefined}><b>{n.label}</b> {n.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;

  const tabs = (
    <div className="gx-seg gx-seg--fill" role="tablist" aria-label="Output" data-tabs={4}>
      {ORDER.filter((t) => COMPOSER_TYPES.includes(t)).map((t) => (
        <button key={t} type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "compose" && state.type === t} onClick={() => dispatchType(t)}><span>{TYPE_TAB[t]}</span></button>
      ))}
      <button type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "edit"} onClick={() => setMode("edit")} data-testid="gen-tab-edit"><span>Edit</span></button>
    </div>
  );
  /* The engine line (README § 0 rule 2): the engine, what it renders and one take's live price as the composer quotes it. */
  const engineSpec = (state.type === "audio"
    ? [model?.audioTask === "speech" ? composer.voice?.name : soundTask ? `${composer.seconds} s` : model?.durations?.length ? `${settings.duration} s` : null]
    : state.type === "image" ? [settings.ratio, settings.resolution]
    : [settings.resolution, model?.durations?.length ? `${settings.duration} s` : null]).filter(Boolean) as string[];
  /* Every paid control carries the server's figure: the engine line one take's (the composer's live quote; a sound's rate before
     any words), the button what its press approves (every take). Hovering either shows the dollars. */
  const engineFigure: MakeFigure | null = composer.credits != null ? makeFigure(composer.credits, composer.quote?.approximate) : makeFigure(idleOne);
  const buttonFig: MakeFigure | null = buttonFigure(composer.quote, composer.quoteKey, takesCount) ?? makeFigure(idleOne != null ? idleOne * takesCount : null);
  const buttonTitle = useFigureTitle(buttonFig);
  const engineTitle = useFigureTitle(engineFigure);
  const buttonWords = figureWords(buttonFig);
  const buttonName = buttonWords ? `${buttonParts.action} · ${buttonWords}` : buttonParts.action;
  /* What every row's figure is at: the composer's own size and length for one take, so a row is never read at a size it does not name. */
  const sheetBasis = [...engineSpec, takesCount > 1 ? "each take" : "one take"].join(" · ");
  const banner = projectsError ? <LoadBanner banner={{ tone: "error", message: projectsError }} onRetry={onRetry ?? (() => undefined)} testId="projects-error" /> : null;
  const compose = mode === "edit" ? (
    <div className="gx-make-compose">
      <section className="gx-gen-card" aria-label="Output">{tabs}</section>
      <SeedanceEditHost scope={scope} project={project} onBack={() => setMode("compose")} />
    </div>
  ) : (
    <section className="gx-gen-card gx-make-compose" aria-label="Composer">
      {banner}
      {pickedUp.length ? (
        <button type="button" className="gx-hbtn gx-resumed-jump" data-tone={rendering ? "blue" : "amber"} onClick={jumpToPickedUp} data-testid="gen-resumed-jump">
          <span className="gx-resumed-dot" aria-hidden="true" />
          {rendering ? `${rendering} ${rendering === 1 ? "take" : "takes"} still rendering` : `${pickedUp.length} earlier ${pickedUp.length === 1 ? "take" : "takes"} to check`}
        </button>
      ) : null}
      {tabs}
      {recipeCardView}

      <div className="gx-gen-row">
        {presetNote ? <p className="gx-gen-note" role="status" data-testid="gen-preset-note">{presetNote}</p> : null}
        <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToGen} testId="gen-attach"><textarea ref={promptBox} className="gx-textarea gx-make-words" aria-label="Direction" rows={4} placeholder={PLACEHOLDER[state.type]} value={state.prompt}
          onChange={(e) => { composer.dispatch({ type: "prompt", value: e.target.value }); typeahead.track(e.target); }} {...typeahead.inputProps} data-testid="gen-prompt" />{typeahead.list}</PromptAttach>
      </div>

      {takesReferences ? (
        <div className="gx-gen-row">
          <div className="gx-make-label"><span className="gx-eyebrow" data-functional-label="">References</span>{state.references.length ? <span className="gx-hint">{state.references.length}</span> : null}</div>
          <div className="gx-well" data-over={over} data-testid="gen-well"
            onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setOver(false);
              /* A tile from anywhere, or files from the device (uploaded into the project first). */
              const payload = readDrop(e.dataTransfer, project?.assets);
              void dropToIds(payload, { scope, projectId: project?.id }).then(({ ids, notes }) => { ids.forEach((id) => void drop(id)); if (notes.length) setWellError(notes.join(" ")); })
                .catch((error: unknown) => setWellError(error instanceof Error ? error.message : "The files could not be uploaded."));
            }}>
            {state.references.length ? state.references.map((r, i) => (
              <span className="gx-ref" key={r.key}>
                <span className="gx-ref-thumb">{r.kind === "image" || r.kind === "video" ? <LazyMedia url={r.url} kind={r.kind} alt="" name={r.name} className="gx-lazy" />
                  : r.kind === "audio" ? <svg viewBox="0 0 32 32" aria-hidden="true" className="gx-ref-wave"><path d="M7 14v4M11 10v12M15 6v20M19 11v10M23 8v16M27 13v6" /></svg> : null}</span>
                <span className="gx-ref-name">{wellTags[i]} · {r.name}</span>
                <button type="button" className="gx-ref-x" aria-label={`Remove ${r.name}`} onClick={() => composer.dispatch({ type: "removeReference", key: r.key })}>×</button>
              </span>
            )) : <span className="gx-well-hint">{cinemaModel ? "Drag stills, clips or WAV sounds here from the Library." : "Drag an asset here from the Library."}</span>}
          </div>
          {wellError ? <p className="gx-gen-error" role="alert">{wellError}</p> : null}
        </div>
      ) : null}

      <button ref={modelButton} type="button" className="gx-make-engine" aria-haspopup="dialog" aria-expanded={sheet} onClick={openSheet} title="Studio engine · Change" data-testid="gen-model">
        <Glyph name="spark" size={16} className="gx-glyph" />
        <span className="gx-make-engine-line">
          <span className="gx-model-name">{model?.label ?? "Choose an engine"}</span>
          {engineSpec.map((part) => <span key={part} className="gx-make-engine-part">{part}</span>)}
          {engineFigure ? <span className="gx-make-engine-part gx-mono" data-testid="make-engine-price" title={engineTitle}><MakeFigureView figure={engineFigure} /></span> : null}
        </span>
        <span className="gx-make-change">Change</span>
      </button>

      {state.notice ? <p className="gx-gen-note" role="status">{state.notice}</p> : null}
      {composer.projectNotice ? <p className="gx-gen-note" role="status">{composer.projectNotice}</p> : null}
      {/* Why Make waits keeps its line when there is no reason, so Make below it stays put as a price lands or a submission starts. */}
      {block ? <p className="gx-reason gx-gen-reason" id="gx-gen-blocked" data-testid="gen-blocked">{block}</p> : <p className="gx-reason gx-gen-reason" aria-hidden="true" />}
      <div className="gx-gen-cta gx-make-go">
        <span className="gx-make-dest" data-testid="make-dest">To {project?.name ?? "a new project"} · Library</span>
        {/* What it does, then what it costs: the price is its own run of text, so a narrow button (or a wide font)
            moves it whole onto a second line and never cuts it. The button is named by the whole label. */}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(block) || submitting} aria-describedby={block ? "gx-gen-blocked" : undefined} onClick={generate} data-testid="gen-generate"
          aria-label={submitting ? "Submitting…" : recipeWait ? "Make" : buttonName} title={!submitting && !recipeWait ? buttonTitle : undefined}
          data-priced={!submitting && !recipeWait && buttonFig ? "" : undefined} data-spend={!submitting && !recipeWait && buttonFig ? "priced" : "unpriced"}>
          {submitting ? "Submitting…" : recipeWait ? "Make" : (
            <>
              <span className="gx-go-act">{buttonParts.action}</span>
              {buttonFig ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span><MakeFigureView figure={buttonFig} /></span> : null}
            </>
          )}
        </button>
      </div>

      <div className="gx-make-tools" data-testid="make-quick-tools">
        <span className="gx-eyebrow" data-functional-label="">Quick tools</span>
        <div className="gx-make-tools-row">
          {QUICK_TOOLS.map(({ tool: t, glyph }) => (
            <button key={t} type="button" className="gx-hbtn" onClick={() => setMake(t)} data-testid={`make-tool-${t}`}><Glyph name={glyph} size={16} className="gx-glyph" /><span>{toolName(t)}</span></button>
          ))}
        </div>
      </div>

      {/* Below: every control Make's drawn panel does not have yet (README § 3.2 draws none of them), exactly as Gen had them
          and in Gen's order — the film chips and Enhance under the words, then the output's own settings, then takes. */}
      <div className="gx-make-more" data-testid="make-more">
        {cinemaModel
          ? <FilmChips key="cinema" scope={scope} type={state.type} setup={state.cinema} onChange={setCinema} bank={CINEMA_BANK} testId="gen-cinema" />
          : <FilmChips key="film" scope={scope} type={state.type} setup={state.shot} onChange={setShot} />}
        <div className="gx-gen-enhance">
          <button type="button" className="gx-toggle" role="switch" aria-checked={enhancer.auto} onClick={() => enhancer.setAuto(!enhancer.auto)} title="When an enhancement is on the card, it is what gets generated.">
            <span className="gx-toggle-dot" aria-hidden="true" /><span>Auto</span>
          </button>
          <span className="gx-spacer" />
          {enhancer.blocked ? <span className="gx-reason" data-testid="enhance-reason">{enhancer.blocked}</span> : null}
          <button type="button" className="gx-hbtn" disabled={Boolean(enhancer.blocked) || enhancer.busy} onClick={enhancer.enhance} data-testid="enhance">
            {enhancer.busy ? "Enhancing…" : enhancer.credits == null ? "Enhance" : `Enhance · ${enhancer.credits.toLocaleString("en-US")} cr`}
          </button>
        </div>
        {enhancer.error ? <p className="gx-gen-error" role="alert">{enhancer.error}</p> : null}
        {enhancer.enhanced ? (
          <div className="gx-enhanced" data-testid="enhanced-card">
            <span className="gx-eyebrow" data-functional-label="">Enhanced · {ENHANCER_LABEL[enhancer.provider ?? DEFAULT_ENHANCER]}{enhancer.charged != null ? ` · ${enhancer.charged.toLocaleString("en-US")} cr` : ""}</span>
            <p>{enhancer.enhanced}</p>
            <div className="gx-enhanced-actions">
              <button type="button" className="gx-hbtn" onClick={() => { composer.dispatch({ type: "prompt", value: enhancer.enhanced! }); enhancer.dismiss(); }} data-testid="enhanced-use">Use this</button>
              <button type="button" className="gx-hbtn" onClick={enhancer.dismiss} data-testid="enhanced-keep">Keep mine</button>
            </div>
          </div>
        ) : null}

        {model?.ratios?.length ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Aspect</span>
            <div className="gx-chips" role="group" aria-label="Aspect">
              {model.ratios.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.ratio === r} onClick={() => composer.dispatch({ type: "pick", value: { ratio: r } })}>{r}</button>)}
            </div>
          </div>
        ) : null}
        {/* Draft mode (lib/draftFinal.ts). */}
        {state.type === "video" && draftOffered(model) ? (
          <div className="gx-gen-row" data-testid="gen-draft-option">
            <span className="gx-eyebrow" data-functional-label="">Draft</span>
            <div className="gx-draft-option">
              <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.draft)} onClick={() => composer.dispatch({ type: "pick", value: { draft: !settings.draft } })} data-testid="gen-draft-toggle">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>Draft first · 480p</span>
              </button>
              {settings.draft ? <p className="gx-hint" data-testid="gen-draft-note">A watermarked draft at the 480p price. Make its 1080p final from it within seven days.</p> : null}
            </div>
          </div>
        ) : null}
        {model?.resolutions?.length ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Resolution</span>
            <div className="gx-chips" role="group" aria-label="Resolution">
              {model.resolutions.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.resolution === r} disabled={Boolean(settings.draft) && r !== settings.resolution}
                title={settings.draft && r !== settings.resolution ? "A draft is 480p; its final is 1080p." : undefined} onClick={() => composer.dispatch({ type: "pick", value: { resolution: r } })}>{r}</button>)}
            </div>
          </div>
        ) : null}
        {model?.durations?.length ? (
          <div className="gx-gen-row">
            <label className="gx-eyebrow" htmlFor="gx-length" data-functional-label="">Length</label>
            <select id="gx-length" className="gx-select" value={settings.duration} onChange={(e) => composer.dispatch({ type: "pick", value: { duration: Number(e.target.value) } })} data-testid="gen-length">
              {model.durations.map((d) => <option key={d} value={d}>{d} s</option>)}
            </select>
          </div>
        ) : null}
        {/* Cinema Studio's Sound switch: off unless turned on here, whatever sound references the well holds. It is in the
            price's key, so turning it on or off asks for the price again before Make. */}
        {soundOffered(model) ? (
          <div className="gx-gen-row" data-testid="gen-sound-option">
            <span className="gx-eyebrow" data-functional-label="">Sound</span>
            <div className="gx-sound-option">
              <button type="button" className="gx-toggle" role="switch" aria-checked={Boolean(settings.generateAudio)}
                onClick={() => composer.dispatch({ type: "pick", value: { generateAudio: !settings.generateAudio } })} data-testid="gen-sound-toggle">
                <span className="gx-toggle-dot" aria-hidden="true" /><span>With sound</span>
              </button>
            </div>
          </div>
        ) : null}
        {/* Sound: a line's voice (the model's own vendor's, so the list swaps with the model), a length for effects and
            music, and music's Instrumental. Each is in the price's key: a change is priced again before Make. */}
        {model?.audioTask === "speech" ? (
          <div className="gx-gen-row">
            <label className="gx-eyebrow" htmlFor="gx-voice" data-functional-label="">Voice</label>
            <select id="gx-voice" className="gx-select" value={composer.voice?.id ?? ""} onChange={(e) => composer.dispatch({ type: "voice", value: e.target.value })} data-testid="gen-voice">
              {composer.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        ) : null}
        {soundTask ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" id="gx-seconds-label" data-functional-label="">Length</span>
            <div className="gx-gen-sound">
              <div className="gx-stepper" role="group" aria-labelledby="gx-seconds-label" data-testid="gen-seconds">
                <button type="button" aria-label="Shorter" disabled={composer.seconds <= AUDIO_SECONDS[soundTask].min} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(soundTask, composer.seconds, -1), task: soundTask })}>–</button>
                <span aria-live="polite" data-testid="gen-seconds-value">{composer.seconds} s</span>
                <button type="button" aria-label="Longer" disabled={composer.seconds >= AUDIO_SECONDS[soundTask].max} onClick={() => composer.dispatch({ type: "seconds", value: stepAudioSeconds(soundTask, composer.seconds, 1), task: soundTask })}>+</button>
              </div>
              {soundTask === "music" ? (
                <button type="button" className="gx-toggle" role="switch" aria-checked={state.instrumental} onClick={() => composer.dispatch({ type: "instrumental", value: !state.instrumental })} data-testid="gen-instrumental">
                  <span className="gx-toggle-dot" aria-hidden="true" /><span>Instrumental</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="gx-gen-takes" data-testid="gen-takes">
          {/* A draft goes one at a time: its final is made from it (lib/draftFinal.ts). */}
          <span className="gx-hint">{settings.draft ? "Takes · one draft at a time" : "Takes"}</span>
          <div className="gx-stepper" role="group" aria-label="Takes per generate">
            <button type="button" aria-label="Fewer" disabled={Boolean(settings.draft) || state.count <= 1} onClick={() => composer.dispatch({ type: "count", value: state.count - 1 })}>–</button>
            <span data-testid="gen-takes-count">{settings.draft ? 1 : state.count}</span>
            <button type="button" aria-label="More" disabled={Boolean(settings.draft) || state.count >= TAKES_MAX} onClick={() => composer.dispatch({ type: "count", value: state.count + 1 })}>+</button>
          </div>
        </div>
        <p className="gx-gen-foot">{footer}{enhancer.auto && enhancer.enhanced ? " · enhanced first" : ""}</p>
        <p className="gx-gen-foot">{composer.wording}</p>
      </div>
    </section>
  );

  const recentView = (
    <section className="gx-gen-results gx-make-recent" aria-label="Results" ref={resultsRef}>
      {banner}
      <div className="gx-chips" role="group" aria-label="Show" data-testid="make-recent-chips">
        {RECENT_CHIPS.map((f) => <button key={f} type="button" className="gx-chip" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`make-recent-${f.toLowerCase()}`}>{f}</button>)}
      </div>
      {view.banner ? <LoadBanner banner={view.banner} onRetry={library.refresh} testId="gen-results-error" /> : null}
      {/* The composer keeps its prompt when the results throw; one bad take costs only its own tile. */}
      <Boundary what="Results" probe="gen-results" resetKey={`${filter}:${project?.id ?? ""}`} fallback={(fault) => <PanelFault fault={fault} name="gen-results" />}>
      <VirtualItems
        className="gx-gen-grid gx-make-cards" items={cells} getKey={(cell: TakeCell<LibraryEntry>) => (cell.kind === "one" ? cell.take.take.id : cell.kind === "draft" ? `draft:${cell.draftId}` : `batch:${cell.batchId}`)} layout={{ columns: 1 }} gap={12} estimateRowHeight={330} scroll="ancestor"
        before={<>
        {running ? (
          <div className="gx-asset gx-tile" data-testid="gen-running" data-face="live" data-done={running.tone === "green" || running.tone === "red"}>
            <div className="gx-tile-media">
              {/* A solid ring: no invented progress. The chip carries the job's own phase. */}
              <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: RING[running.tone ?? "blue"] }} aria-hidden="true" /></span>
              <span className="gx-tile-chip" data-tone={running.tone === "red" ? "failed" : running.tone === "green" ? "done" : "live"}><span className="gx-tile-chip-dot" aria-hidden="true" />{running.label ?? "Rendering"}</span>
            </div>
            <span className="gx-asset-name">{running.name ?? "Rendering"}</span>
            <span className="gx-asset-meta">{running.meta || running.label || "Running"}</span>
          </div>
        ) : null}
        {pickedUp.map(({ job, problem, following }) => {
          const phase = resumePhase(job, following);
          return (
            <div className="gx-asset gx-tile" key={job.id} data-tone={phase.tone} data-status={job.status} data-following={following} data-testid="gen-resumed" title={`${job.model.name} · ${job.quoteCredits.toLocaleString("en-US")} connected cr`}>
              {/* The same solid ring as the composer's own run: the account reports no progress, so none is drawn. */}
              <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: RING[phase.tone] }} aria-hidden="true" /></span>
              <span className="gx-asset-name" title={job.input.prompt}>{job.batch ? `${takeLabel(job.batch.variation)} · ${takeName(job)}` : takeName(job)}</span>
              <span className="gx-asset-meta">{resumeLine(job, clock, following)}</span>
              {/* A failed take: why, what the account's own ledger shows for the charge, and what to do. */}
              {job.status === "failed" && job.failure ? <span className="gx-asset-fail" data-testid="take-failure">{failureLine(job.failure).text}</span> : null}
              {problem ? <span className="gx-resumed-note" role="status">{problem}</span> : null}
              {dismissable({ status: job.status, following }) ? <button type="button" className="gx-hbtn gx-resumed-x" onClick={() => resumed.dismiss(job.id)} aria-label={`Dismiss ${takeName(job)}`}>Dismiss</button> : null}
            </div>
          );
        })}
        {liveBatches.map((batch) => (
          <TakeStrip key={batch.id} batchId={batch.id} testId="gen-batch" state={batch.phase.done ? "done" : "live"}
            label={stripLabel(batch.takes.map((take) => take.variation))} name={batch.name}
            meta={[batch.model, approvedTotal(batch), batch.phase.label].filter(Boolean).join(" · ")}>
            {batch.views.map((view) => {
              const entry = view.generationId ? byGeneration.get(view.generationId) : undefined;
              return (
                /* The same frame as a settled take's card, so a strip does not change height as its takes land. */
                <div className="gx-asset gx-tile gx-batch-take" role="listitem" key={view.variation} data-tone={view.tone} data-status={view.status} data-done={view.done} data-variation={view.variation} data-testid="gen-batch-take">
                  {entry ? thumb(entry) : <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: RING[view.tone] }} aria-hidden="true" /></span>}
                  <span className="gx-asset-name">{view.label}</span>
                  <span className="gx-asset-meta" data-testid="gen-batch-take-status">{view.status}</span>
                </div>
              );
            })}
          </TakeStrip>
        ))}
        {view.skeletons ? <TakeSkeletons count={6} variant="grid" /> : null}
        </>}
        renderItem={(cell: TakeCell<LibraryEntry>) => cell.kind === "one" ? tile(cell.take) : cell.kind === "draft" ? (
          <DraftStrip scope={scope} projectId={project?.id ?? null} draft={cell.draft} finals={cell.finals} tile={pairTile} testId="gen-draft" />
        ) : (
          <TakeStrip batchId={cell.batchId} testId="gen-batch" state="done" name={cell.takes[0].take.name} meta={settledTotal(cell.takes)}
            label={stripLabel(cell.takes.map((entry, i) => { const v = entryBatch(entry)?.variation; return isVariation(v) ? v : i + 1; }))}>
            {cell.takes.map((entry, i) => { const v = entryBatch(entry)?.variation; return tile(entry, takeLabel(isVariation(v) ? v : i + 1)); })}
          </TakeStrip>
        )}
      />
      {!running && !pickedUp.length && !results.length && !liveBatches.length && view.empty ? <p className="gx-empty" data-testid="gen-results-empty">{project ? "Nothing generated in this project yet. What you make lands here, in Takes, and in Library › Assets." : "Open a project, or generate — the composer files a first project for you."}</p> : null}
      {!running && !pickedUp.length && !results.length && !liveBatches.length && made && !view.skeletons ? <p className="gx-empty" data-testid="gen-results-empty">{recentEmpty(filter)}</p> : null}
      </Boundary>
    </section>
  );

  return (
    <aside ref={panel} className="gx-make" aria-label={tool ? toolName(tool) : "Make"} data-testid="make-panel" data-tab={tool ?? (recentTab ? "recent" : state.type)} data-beside={beside ? "" : undefined}
      style={aspect ? ({ "--tile-aspect": aspect } as React.CSSProperties) : undefined}>
      <div className="gx-make-head">
        <strong className="gx-make-title" data-testid="make-title">{tool ? toolName(tool) : "Make"}</strong>
        {tool ? null : (
          <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Make or Recent">
            <button type="button" role="tab" className="gx-seg-btn" aria-selected={!recentTab} onClick={() => setMake(state.type)} data-testid="make-tab-make"><span>Make</span></button>
            <button type="button" role="tab" className="gx-seg-btn" aria-selected={recentTab} onClick={() => setMake("recent")} data-testid="make-tab-recent"><span>Recent</span></button>
          </div>
        )}
        <span className="gx-spacer" />
        {/* Below 1280 the Library is an overlay: Make's way to it, on either tab (README › Library, drag in from it). */}
        {!shell.wide ? <button type="button" className="gx-hbtn gx-make-lib" onClick={() => shell.openLibrary("assets")} data-testid="make-open-library"><Glyph name="stack" size={16} className="gx-glyph" /><span>Library</span></button> : null}
        <button type="button" className="gx-make-close" aria-label="Close Make" title="Close · Esc" onClick={shell.closeMake} data-testid="make-close">×</button>
      </div>
      <div className="gx-make-body gx-scroll" data-testid="gen-view">
        {tool ? <ViralTool key={tool} scope={scope} page={tool} project={project} items={items} /> : recentTab ? recentView : compose}
      </div>

      {/* The veil leaves the panel: an ancestor that contains fixed descendants would hold its `position: fixed`
          (the sheet then rises inside the scroll region, under the phone's tab bar). It lands on the shell
          root so the tokens still reach it. */}
      {sheet ? createPortal(
        <div className="gx-veil gx-veil--make" onClick={closeSheet} data-beside={beside ? "" : undefined} data-testid="model-sheet-veil">
          <ModelSheet label={`${TYPE_TAB[state.type]} models`} catalogue={CATALOGUE}
            offered={offered} recent={recent} selectedId={model?.id ?? null} priceOf={priceOf} basis={sheetBasis}
            loading={blocked === READING_MODELS}
            empty={!offered.length && blocked ? blocked : "No Studio engine is connected for this output."}
            /* The engine list itself is missing (a failed read): read it again. */
            emptyActions={composer.models.some((m) => m.type !== "audio") ? [] : [{ label: "Try again", onClick: composer.retryEngines, testId: "gen-model-retry" }]}
            onPick={pickModel} onClose={closeSheet} />
        </div>,
        document.querySelector(".gx") ?? document.body,
      ) : null}
    </aside>
  );
}

/**
 * Make: today's panel, or with the new interface switched on for this workspace, the panel as the handoff draws it
 * (components/graphite/make/Make.tsx). Customers keep today's until the switch flips (docs/old-shells.md).
 */
export function MakePanel(props: MakeProps) {
  const next = useNewInterface();
  /* `make=change` asks for the engine list open. The shell names the type in the address once it has landed, so the
     ask is read here, on the first render, before that. */
  const [change] = useState(() => typeof window !== "undefined" && wantsChange(window.location.search));
  return next ? <Make {...props} listOpen={change} /> : <MakePanelToday {...props} />;
}
