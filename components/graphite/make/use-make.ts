"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import { dropToIds, readDrop } from "@/lib/drop";
import { displayModelName } from "@/lib/models";
import { isRawPrompt, type EnhanceMode } from "@/lib/shell/enhancer";
import { useGenPresetInbox } from "@/lib/shell/gen-preset";
import { announceMade, inferType, isMakeTool, madeLine, makeDest, makeType, typeNote } from "@/lib/shell/make";
import { exact, priceWords, shortByWords, type PriceValue } from "@/lib/shell/price-words";
import { cites, nearestSetting, recipeChips, referenceTags, retagRecipe, type GenPreset, type RecipeReference } from "@/lib/shell/recipe";
import { useReferenceInbox } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import { useSession } from "@/lib/session";
import { cleanCinemaControls, isCinemaStudioAudioMime, isCinemaStudioModel } from "@/lib/cinemaStudioTypes";
import type { Project } from "@/lib/workbench/studio";
import { composerButtonParts, EMPTY_PROMPT, READING_MODELS, shownTotal, type ComposerModel, type ComposerState, type ComposerType } from "@/lib/workspace/composer";
import { cleanSetup, composeForSend, recoverSetup, withoutSetup, type FilmSetup } from "@/lib/workspace/film-vocabulary";
import { EMPTY_MEMORY, needsPricedRead, rateQuery, readPickerMemory, recentKey, recentModels, rememberRecent, rowPrice, sheetRatesFrom, writePickerMemory, type PickerMemory, type PriceAt, type SheetRates } from "@/lib/workspace/model-picker";
import { useComposer, type ComposerSent } from "@/lib/workspace/use-composer";
import { useWorkspace } from "@/lib/workspace/state";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Make's logic, apart from how it is drawn (components/graphite/make/Make.tsx draws the desktop panel; the phone's
 * simple Make draws the same hook). It drives today's composer (lib/workspace/use-composer.ts) unchanged: the live
 * price, the one send at the price on the button, the held take when credits are short. What it adds is the new
 * interface's Auto (README § 0 rule 2): the type is inferred from the words until the person picks one, and the
 * engine and its settings are the composer's own defaults, shown as one line with Change. Prices come out as
 * PriceValues for components/graphite/Price.tsx; Cinema Studio's approximate figure keeps the composer's own
 * wording until its helper lands (PR #523).
 */

export type MakeInput = {
  scope: string;
  project: Project | null;
  projects?: "loading" | "ready" | "error";
  workspaceName: string | null;
  onProject: (id: string) => void;
  /** The workspace's credit balance, when the host reads it live; else the session's, as the page loaded. */
  balance?: number | null;
  /** A board is open: results land on it too (README § 3.2). */
  onBoard?: boolean;
  /** Start with the engine list open (`make=change`). */
  listOpen?: boolean;
};

/** A price Make shows: a value for components/graphite/Price.tsx, or Cinema Studio's own approximate words. */
export type MakePrice = { value: PriceValue | null; about: string | null };

/** A reference a recreated take cited that Make does not carry: gone from this workspace, or not a picture or a video. */
type MissingReference = { tag: string | null; kind: string; origin: RecipeReference["origin"]; gone: boolean; reason: string };
type Recipe = {
  preset: GenPreset;
  /** The composer exactly as it was, for Undo. */
  previous: ComposerState;
  epoch: number;
  hidden?: boolean;
  refs: { total: number; reading: boolean; missing: MissingReference[]; renumbered: { name: string; was: string; now: string }[]; frames: boolean };
};

/** A sound Cinema Studio takes as a reference: a WAV uploaded to this workspace (generated sounds are MP3). */
const cinemaSound = (asset: Pick<GenInputAsset, "kind" | "origin" | "mime">) => asset.kind === "audio" && asset.origin === "upload" && isCinemaStudioAudioMime(asset.mime);
const CINEMA_SOUND_ONLY = "Cinema Studio takes sound references as WAV files uploaded to this workspace.";
/** How long the words rest before Make infers a type from them. */
const INFER_AFTER_MS = 350;

export function useMake({ scope, project, projects = "ready", workspaceName, onProject, balance, onBoard = false, listOpen: startOpen = false }: MakeInput) {
  const shell = useShell();
  const session = useSession();
  const [initialType] = useState<ComposerType>(() => makeType(shell.make) ?? shell.lastMake);
  const ws = useWorkspace();
  /* A press the server accepted: Make closes, says so, and tells the board (lib/shell/make.ts › announceMade). One held for credits, or a batch with a take
     not accepted, keeps Make open with its line instead: nothing has started. */
  const sent = useCallback((made: ComposerSent) => {
    if (made.held) return;
    ws.toast(madeLine(made.name, priceWords(exact(made.credits)), made.takes));
    announceMade({ projectId: made.projectId, nodeId: made.nodeId, name: made.name });
    shell.closeMake();
  }, [ws, shell]);
  const composer = useComposer({ scope, open: true, project, projects, onProject, workspaceName, initialType, compose: composeForSend, verb: "Make", onSent: sent });
  const { state, model, offered, settings, submitting } = composer;
  const dispatch = composer.dispatch;
  const tool = isMakeTool(shell.make) ? shell.make : null;
  const recent = shell.make === "recent";

  /* ── The type: inferred from the words until the person picks one ─────── */
  /* As the master draws it: `make=1` (Video, the default) is Auto's; Image or Audio named by the address was picked. */
  const [picked, setPicked] = useState(() => initialType !== "video");
  const pickType = useCallback((type: ComposerType) => { setPicked(true); dispatch({ type: "type", value: type }); }, [dispatch]);
  const { setMake } = shell;
  const asked = shell.make;
  const follow = useRef({ dispatch, setMake });
  useEffect(() => { follow.current = { dispatch, setMake }; });
  const synced = useRef({ asked, type: state.type });
  /* The address and the composer name one type: a type the address moved to (a link, Back) is the person's pick, and
     a type the composer moved to (a pick, Auto, a recipe) is written to the address. Each follows only the other's change. */
  useEffect(() => {
    const was = synced.current;
    synced.current = { asked, type: state.type };
    if (!asked || asked === "recent" || isMakeTool(asked) || asked === state.type) return;
    if (asked !== was.asked) { setPicked(true); follow.current.dispatch({ type: "type", value: asked }); }
    else if (state.type !== was.type) follow.current.setMake(state.type);
  }, [asked, state.type]);

  /* ── Presets and recipes (Recreate, ⌘K, Crew, the public site's hero) ─── */
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [preset, setPreset] = useState<GenPreset | null>(null);
  const recipeEpoch = useRef(0);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });

  const anchored = state.references.some((r) => r.kind === "video") || (state.type === "video" && state.references.length > 0);
  const enhancer = useEnhancer({
    prompt: state.prompt, mode: state.type as EnhanceMode, model: model?.id ?? null,
    anchored, editing: state.type === "image" && state.references.length > 0,
  });
  const { dismiss: dismissEnhanced } = enhancer;
  const cinemaModel = model != null && isCinemaStudioModel(model.id);
  const [wellError, setWellError] = useState<string | null>(null);

  const applyPreset = useCallback((next: GenPreset) => {
    setWellError(null);
    if (next.type) setPicked(true);
    if (!next.from) {
      /* New words replace the old, an enhancement of them and any recipe that brought them. */
      if (next.prompt) { recipeEpoch.current++; dismissEnhanced(); setRecipe(null); }
      if (next.type) dispatch({ type: "type", value: next.type });
      if (next.model) dispatch({ type: "model", value: next.model });
      if (next.prompt) dispatch({ type: "prompt", value: next.prompt });
      if (next.picks) dispatch({ type: "pick", value: next.picks });
      if (next.sound?.seconds) dispatch({ type: "seconds", value: next.sound.seconds });
      if (next.sound?.instrumental !== undefined) dispatch({ type: "instrumental", value: next.sound.instrumental });
      if (next.sound?.voiceId) dispatch({ type: "voice", value: next.sound.voiceId });
      setPreset(next);
      return;
    }
    const epoch = ++recipeEpoch.current;
    if (!next.settingsOnly) dismissEnhanced();
    const previous = latest.current;
    const settingsOnly = Boolean(next.settingsOnly);
    const type = next.type ?? previous.type;
    const refs = settingsOnly || type === "audio" ? [] : next.references ?? [];
    /* Every take recreates on this workspace's engines: one made on the retired account catalogue keeps its words and settings. */
    const lost = next.billing === "connected";
    /* The shot setup lands on its chips, and comes back out of the words it was written into. */
    const kept = cleanSetup(next.shotSpec);
    const found = Object.keys(kept).length ? null : recoverSetup(next.prompt, type);
    const shot = found?.setup ?? kept;
    const taken = found ? { ...next, shotSpec: found.setup } : next;
    const onCinema = !lost && Boolean(next.model && isCinemaStudioModel(next.model));
    const cinema = cleanCinemaControls(next.cinema);
    setPicked(true);
    dispatch({
      type: "recipe",
      value: {
        type, billing: "workspace", picks: next.picks ?? {}, sound: next.sound, shot, cinema,
        ...(lost ? {} : { model: next.model }),
        ...(settingsOnly ? {} : { prompt: found ? found.words : withoutSetup(next.prompt, shot), references: [] }),
      },
    });
    setPreset(null);
    setRecipe({ preset: taken, previous, epoch, refs: { total: refs.length, reading: refs.length > 0, missing: [], renumbered: [], frames: false } });
    if (!refs.length) return;
    /* Every reference is read again in this workspace; the words are renumbered to the ones still here. */
    void Promise.allSettled(refs.map((r) => resolveGenInput(`${r.origin}:${r.id}`, scope))).then((results) => {
      if (recipeEpoch.current !== epoch) return;
      const assets = results.map((result) => (result.status === "fulfilled" ? result.value : null));
      const usable = assets.map((asset) => (asset && (asset.kind === "image" || asset.kind === "video") ? { ...asset, kind: asset.kind }
        : asset && onCinema && cinemaSound(asset) ? { ...asset, kind: "audio" as const } : null));
      const kinds = refs.map((r, i) => (r.kind ?? assets[i]?.kind ?? "image"));
      const tags = retagRecipe(latest.current.prompt, kinds.map((kind, i) => ({ kind, found: Boolean(usable[i]) })));
      const missing: MissingReference[] = [];
      const renumbered: Recipe["refs"]["renumbered"] = [];
      usable.forEach((asset, i) => {
        const r = refs[i];
        if (asset) {
          dispatch({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url, ...(r.role ? { role: r.role } : {}) } });
          if (tags.was[i] && tags.now[i] && tags.was[i] !== tags.now[i] && cites(tags.prompt, tags.now[i]!)) renumbered.push({ name: asset.name, was: tags.was[i]!, now: tags.now[i]! });
          return;
        }
        const result = results[i];
        missing.push(assets[i]
          ? { tag: null, kind: assets[i]!.kind, origin: r.origin, gone: false, reason: assets[i]!.kind === "audio" && onCinema ? CINEMA_SOUND_ONLY : "References are images and videos." }
          : { tag: tags.now[i], kind: kinds[i], origin: r.origin, gone: true, reason: result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "Not found in this workspace." });
      });
      if (tags.prompt !== latest.current.prompt) dispatch({ type: "prompt", value: tags.prompt });
      const frames = usable.some((asset, i) => asset && /first_frame|last_frame/.test(refs[i].role ?? ""));
      setRecipe((now) => (now?.epoch === epoch ? { ...now, refs: { total: refs.length, reading: false, missing, renumbered, frames } } : now));
    });
  }, [scope, dispatch, dismissEnhanced]);
  /* A quick tool reads its own letters; the composer's arrive while it is drawn. */
  useGenPresetInbox(applyPreset);
  const presetNote = !preset?.note ? null
    : preset.model && model && composer.models.length && model.id !== preset.model ? `${preset.note} · ${displayModelName(preset.model)} is not offered here; ${model.label} is selected` : preset.note;
  const undoRecipe = useCallback(() => {
    if (!recipe) return;
    recipeEpoch.current++;
    dispatch({ type: "restore", value: recipe.previous });
    dismissEnhanced();
    setRecipe(null);
    setPreset(null);
  }, [recipe, dispatch, dismissEnhanced]);
  const hideRecipe = useCallback(() => setRecipe((now) => (now ? { ...now, hidden: true } : now)), []);
  /* A size or length the engine does not offer lands on the nearest it does, never above the take's. */
  const wantedSize = recipe?.preset.picks?.resolution;
  const wantedSeconds = recipe?.preset.picks?.duration;
  const heldSize = state.picks.resolution;
  const heldSeconds = state.picks.duration;
  const sizes = model?.resolutions;
  const lengths = model?.durations;
  useEffect(() => {
    const size = wantedSize && heldSize === wantedSize && sizes ? nearestSetting(wantedSize, sizes) : undefined;
    const seconds = wantedSeconds && heldSeconds === wantedSeconds && lengths ? nearestSetting(wantedSeconds, lengths) : undefined;
    if (size !== undefined || seconds !== undefined) dispatch({ type: "pick", value: { ...(size !== undefined ? { resolution: size } : {}), ...(seconds !== undefined ? { duration: seconds } : {}) } });
  }, [wantedSize, wantedSeconds, heldSize, heldSeconds, sizes, lengths, dispatch]);

  /* ── Auto: the type from the words, after they rest ─────────────────── */
  const inferred = picked || recipe ? null : inferType(state.prompt, { references: state.references.length });
  useEffect(() => {
    if (!inferred || inferred === state.type) return;
    const timer = setTimeout(() => follow.current.dispatch({ type: "type", value: inferred }), INFER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [inferred, state.type]);

  /* ── References ─────────────────────────────────────────────────────── */
  const addReference = useCallback(async (id: string) => {
    setWellError(null);
    try {
      const asset = await resolveGenInput(id, scope);
      if (asset.kind === "audio" && cinemaModel) {
        if (!cinemaSound(asset)) throw new Error(CINEMA_SOUND_ONLY);
        dispatch({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: "audio", name: asset.name, url: asset.url } });
        return;
      }
      if (asset.kind !== "image" && asset.kind !== "video") throw new Error(cinemaModel ? "References are images, videos and WAV sounds." : "References are images and videos.");
      dispatch({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url } });
    } catch (error) {
      setWellError(error instanceof Error ? error.message : "This file cannot be used as a reference.");
    }
  }, [scope, dispatch, cinemaModel]);
  /* The Library's `+`, a right-click or a drop on any page lands here; a quick tool takes the letters while it is open. */
  const inbox = useCallback((letter: { id: string }) => { void addReference(letter.id); }, [addReference]);
  useReferenceInbox(tool ? null : inbox);
  /** A drop on the well: a tile from anywhere, or files from the device (uploaded into the project first). */
  const dropOnWell = useCallback((data: DataTransfer) => {
    const payload = readDrop(data, project?.assets);
    void dropToIds(payload, { scope, projectId: project?.id })
      .then(({ ids, notes }) => { ids.forEach((id) => void addReference(id)); if (notes.length) setWellError(notes.join(" ")); })
      .catch((error: unknown) => setWellError(error instanceof Error ? error.message : "The files could not be uploaded."));
  }, [project?.assets, project?.id, scope, addReference]);
  const removeReference = useCallback((key: string) => dispatch({ type: "removeReference", key }), [dispatch]);
  const takesReferences = state.type !== "audio";
  /* The words cite each reference the way the engine counts it: @Image1, @Video1, @Audio1, within its own kind. */
  const tags = referenceTags(state.references.map((r) => r.kind));

  /* ── The engines, priced where the composer stands (Change) ─────────── */
  const scopedFetch = useScopedFetch(scope);
  const [listOpen, setListOpen] = useState(startOpen);
  const [memory, setMemory] = useState<PickerMemory>(EMPTY_MEMORY);
  const openList = useCallback(() => { setMemory(readPickerMemory(scope)); setListOpen(true); }, [scope]);
  const closeList = useCallback(() => setListOpen(false), []);
  const used = useCallback((id: string) => writePickerMemory(scope, rememberRecent(readPickerMemory(scope), recentKey(state.type, id))), [scope, state.type]);
  const pickEngine = useCallback((m: ComposerModel) => { used(m.id); dispatch({ type: "model", value: m.id }); setListOpen(false); }, [used, dispatch]);
  const recentEngines = useMemo(() => recentModels(memory.recent, state.type, offered), [memory.recent, state.type, offered]);
  const draftTakes = settings.draft ? 1 : state.count;
  const priceAt = useMemo<PriceAt>(() => ({ aspect: composer.project?.aspect, picks: state.picks, references: state.references, seconds: Math.round(state.seconds), takes: draftTakes }),
    [composer.project?.aspect, state.picks, state.references, state.seconds, draftTakes]);
  const priceKey = rateQuery(priceAt);
  const [sheetRates, setSheetRates] = useState<SheetRates | null>(null);
  const wantsRates = listOpen && needsPricedRead(offered, priceAt);
  const ratesKey = sheetRates?.key ?? null;
  useEffect(() => {
    if (!wantsRates || ratesKey === priceKey) return;
    let live = true;
    void scopedFetch(`/api/workbench/engines?${priceKey}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error("unpriced"); return r.json(); })
      .then((reply) => { if (live) setSheetRates(sheetRatesFrom(priceKey, reply)); })
      /* An unread price leaves those rows without a figure; the next opening asks again. */
      .catch(() => { if (live) setSheetRates({ key: priceKey, models: {}, audio: null, failed: true }); });
    return () => { live = false; };
  }, [wantsRates, ratesKey, priceKey, scopedFetch]);
  const rates = sheetRates?.key === priceKey ? sheetRates : null;
  const readingRates = wantsRates && !rates;
  /** One row's figure, as a price: exact where the server priced the row, none where it did not. */
  const rowValue = useCallback((m: ComposerModel): { value: PriceValue | null; title: string } => {
    const row = rowPrice(m, null, priceAt, rates, readingRates);
    /* Cinema Studio's rows carry an approximate figure; its words are its own (PR #523), so the row shows none. */
    return { value: row.kind === "rate" && row.credits != null && !row.approximate ? exact(row.credits) : null, title: row.kind === "none" ? "Priced on Make once the words are in" : row.title };
  }, [priceAt, rates, readingRates]);

  /* ── The words ───────────────────────────────────────────────────────── */
  const setPrompt = useCallback((value: string) => dispatch({ type: "prompt", value }), [dispatch]);
  const setShot = useCallback((value: FilmSetup) => dispatch({ type: "shot", value }), [dispatch]);
  const setCinema = useCallback((value: FilmSetup) => dispatch({ type: "cinema", value }), [dispatch]);

  /* ── Make ────────────────────────────────────────────────────────────── */
  /* A recreated take is not sent half-read: while its references are still being read, or the words cite one that is gone, Make waits. */
  const orphans = recipe && !recipe.refs.reading
    ? recipe.refs.missing.filter((m) => m.gone && m.tag && cites(state.prompt, m.tag) && state.references.filter((r) => r.kind === m.kind).length < Number(m.tag.replace(/\D/g, "")))
    : [];
  const orphan = orphans[0];
  const recipeWait = !recipe ? null
    : recipe.refs.reading ? "Reading the take’s references…"
    : orphan ? `The words cite ${orphan.tag}, which is gone. Add a reference or change the words.`
    : null;
  const waiting = composer.blocked === EMPTY_PROMPT ? "Say what to make." : composer.blocked;
  const blocked = submitting ? waiting : recipeWait ?? waiting;
  /* Auto (Advanced): with an enhancement on the card, it is what goes. */
  const pending = useRef(false);
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    if (!recipeWait) composer.generate();
  }, [state.prompt, composer, recipeWait]);
  const make = useCallback(() => {
    if (recipeWait) return;
    if (model && !composer.blocked) used(model.id);
    if (enhancer.auto && enhancer.enhanced && enhancer.enhanced !== state.prompt && !isRawPrompt(state.prompt)) {
      pending.current = true;
      dispatch({ type: "prompt", value: enhancer.enhanced });
      enhancer.dismiss();
      return;
    }
    composer.generate();
  }, [recipeWait, model, composer, used, enhancer, state.prompt, dispatch]);

  /* ── What the line and the button say ───────────────────────────────── */
  const count = settings.draft ? 1 : Math.max(1, state.count);
  const approximate = Boolean(composer.quote?.approximate);
  const takeCredits = composer.credits;
  const total = submitting ? null : shownTotal(composer.quote, composer.quoteKey, count);
  /* Cinema Studio's approximate figure keeps the composer's own words ("about N cr") until PR #523's helper lands. */
  const aboutOneTake = () => composerButtonParts({ quote: composer.quote, quoteKey: composer.quoteKey, submitting: false, count: 1, verb: "Make" }).price;
  const soundTask = model?.audioTask === "sound" || model?.audioTask === "music" ? model.audioTask : null;
  const line = (state.type === "audio"
    ? [model?.label, model?.audioTask === "speech" ? composer.voice?.name : soundTask ? `${composer.seconds} s` : null]
    : state.type === "image" ? [model?.label, settings.resolution]
    : [model?.label, settings.resolution, model?.durations?.length ? `${settings.duration} s` : null]).filter((part): part is string => Boolean(part));
  const linePrice: MakePrice | null = takeCredits == null ? null : approximate ? { value: null, about: aboutOneTake() } : { value: exact(takeCredits), about: null };
  const goPrice: MakePrice | null = total == null ? null : approximate ? { value: null, about: composer.buttonParts.price } : { value: exact(total), about: null };
  const balanceNow = balance !== undefined ? balance : session.credits?.balance ?? null;
  /* Make stays pressable when the balance is short (the take waits, held, until credits arrive): the line only says so. */
  const short = !approximate && total != null && !submitting ? shortByWords(balanceNow, exact(total)) : null;

  return {
    composer, state, model, settings, offered, tool, recent, submitting,
    picked, pickType, typeNote: tool ? null : typeNote(state.prompt, picked),
    setPrompt, setShot, setCinema, cinemaModel,
    references: state.references, tags, takesReferences, addReference, dropOnWell, removeReference, wellError,
    listOpen, openList, closeList, pickEngine, rowValue, readingRates, recentEngines,
    readingModels: composer.blocked === READING_MODELS,
    line, linePrice, go: { action: composer.buttonParts.action, price: goPrice, blocked, press: make }, short,
    dest: makeDest(composer.project?.name, onBoard),
    notices: [state.notice, composer.projectNotice, presetNote].filter((n): n is string => Boolean(n)),
    recipe: recipe && !recipe.hidden ? {
      name: recipe.preset.from?.name ?? null, settingsOnly: Boolean(recipe.preset.settingsOnly), reading: recipe.refs.reading,
      chips: recipeChips({
        preset: recipe.preset, type: state.type, billing: "workspace", model, models: composer.models, settings, owner: false,
        reading: composer.blocked === READING_MODELS, blocked: model ? null : composer.blocked, identities: null,
        sound: { seconds: composer.seconds, instrumental: state.instrumental, voice: composer.voice, voices: composer.voices },
      }),
      missing: recipe.refs.missing, total: recipe.refs.total,
      undo: undoRecipe, hide: hideRecipe,
    } : null,
    enhancer, soundTask,
  };
}

export type MakeModel = ReturnType<typeof useMake>;
