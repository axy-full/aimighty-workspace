"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { dropToIds, isDroppable, readDrop } from "@/lib/drop";
import { createPortal } from "react-dom";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { resolveGenInput } from "@/lib/genAssetInput";
import { ENHANCER_LABEL, isRawPrompt, type EnhanceMode } from "@/lib/shell/enhancer";
import { GEN_PRESET_KEY, readGenPreset } from "@/lib/shell/assets";
import { cites, nearestSetting, recipeChips, referenceTags, retagRecipe, type GenPreset, type RecipeReference } from "@/lib/shell/recipe";
import { sendRecipe, useRecipeInbox, useReferenceInbox } from "@/lib/shell/reference-inbox";
import { useShell } from "@/lib/shell/state";
import { useEnhancer } from "@/lib/shell/use-enhancer";
import type { Project } from "@/lib/workbench/studio";
import { COMPOSER_TYPES, READING_ACCOUNT, READING_MODELS, TAKES_MAX, type BillingSource, type ComposerModel, type ComposerState, type ComposerType } from "@/lib/workspace/composer";
import { EMPTY_MEMORY, needsPricedRead, rateQuery, readPickerMemory, recentKey, recentModels, rememberQuote, rememberRecent, rowPrice, sheetRatesFrom, writePickerMemory, type PickerMemory, type PriceAt, type SheetRates } from "@/lib/workspace/model-picker";
import { useSession } from "@/lib/session";
import { ModelSheet } from "./ModelSheet";
import { WORKFLOW_SURFACES } from "@/lib/shell/workflows";
import { WorkflowHost } from "./tools/WorkflowHost";
import { SeedanceEditHost } from "./tools/SeedanceEditHost";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import type { ConnectedCharacter } from "@/lib/higgsfield-consumer/characters";
import { useComposer } from "@/lib/workspace/use-composer";
import { VirtualItems } from "@/components/workspace/VirtualItems";
import { cleanSetup, setupLabels, withoutSetup, type FilmSetup } from "@/lib/workspace/film-vocabulary";
import { FilmChips, useFilmTypeahead } from "./FilmVocabulary";

const TYPE_TAB: Record<ComposerType, string> = { video: "Video", image: "Images", audio: "Audio" };
const ORDER: ComposerType[] = ["video", "image", "audio"];
const PLACEHOLDER: Record<ComposerType, string> = {
  video: "Describe the shot: subject, setting, action. # picks a camera move; @name cites a reference; raw: sends your words as written.",
  image: "Describe the frame: subject, setting, medium. # picks a shot, lens or light; @name cites a reference; raw: sends your words as written.",
  audio: "Describe the sound, the voice or the music: source, setting, pace, texture.",
};
const GROUPS: { id: BillingSource; label: string }[] = [{ id: "workspace", label: "Studio engines" }, { id: "connected", label: "Higgsfield catalogue" }];
const FILTERS = ["All", "Images", "Video", "Audio"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_MEDIA: Record<Filter, LibraryEntry["media"] | "all"> = { All: "all", Images: "image", Video: "video", Audio: "audio" };
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

/** Gen (README › Gen): one composer on the left, this project's results on the right. */
export function GenView({ scope, project, items, workspaceName, onProject }: {
  scope: string; project: Project | null; items: LibraryEntry[]; workspaceName: string | null; onProject: (id: string) => void;
}) {
  const shell = useShell();
  const ws = useWorkspace();
  const composer = useComposer({ scope, open: true, project, onProject, workspaceName, initialType: "video" });
  const { state, model, offered, settings, blocked, buttonLabel, submitting } = composer;
  const dispatchComposer = composer.dispatch;
  const [mode, setMode] = useState<"compose" | "analysis" | "edit">("compose");
  /* Soul models carry a trained character: the account's list is read once a Soul model is chosen. */
  const scopedFetch = useScopedFetch(scope);
  const [characters, setCharacters] = useState<{ list: ConnectedCharacter[] | null; note: string }>({ list: null, note: "Reading the account’s characters…" });
  const wantsCharacters = Boolean(model?.soulId) && state.billing === "connected";
  useEffect(() => {
    if (!wantsCharacters || characters.list) return;
    let live = true;
    void scopedFetch(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "characters" }) })
      .then(async (r) => { const json = await r.json().catch(() => null) as { connected?: boolean; available?: boolean; characters?: ConnectedCharacter[]; error?: string } | null; if (!r.ok) throw new Error(json?.error ?? "The account’s characters could not be read."); return json; })
      .then((json) => {
        if (!live) return;
        const list = json?.characters ?? [];
        const ready = list.filter((c) => c.status !== "training" && c.status !== "failed").length;
        setCharacters({ list, note: json?.connected === false ? "Connect the owner’s account in Workspace › Engines." : json?.available === false ? "The connected account does not advertise its characters." : ready ? `${ready} ${ready === 1 ? "identity" : "identities"} built in Particl.` : "No identity built in Particl yet — Cast › Build identity." });
      })
      .catch((error: unknown) => { if (live) setCharacters({ list: [], note: error instanceof Error ? error.message : "The account’s characters could not be read." }); });
    return () => { live = false; };
  }, [wantsCharacters, characters.list, scopedFetch]);
  const [sheet, setSheet] = useState(false);
  /* The connected catalogue is the owner's (composerBlock refuses anyone else): members are not shown the switch at all. */
  const session = useSession();
  const groups = session.owner ? GROUPS : GROUPS.filter((g) => g.id === "workspace");
  useEffect(() => { if (!session.owner && state.billing === "connected") dispatchComposer({ type: "billing", value: "workspace" }); }, [session.owner, state.billing, dispatchComposer]);
  /* What this browser remembers for the sheet (recent picks, last connected quotes), read fresh each time it opens. */
  const [memory, setMemory] = useState<PickerMemory>(EMPTY_MEMORY);
  const modelButton = useRef<HTMLButtonElement>(null);
  const openSheet = () => { setMemory(readPickerMemory(scope)); setSheet(true); };
  const closeSheet = () => { setSheet(false); setSheetRates((r) => (r?.failed ? null : r)); modelButton.current?.focus({ preventScroll: true }); };
  const used = (id: string) => writePickerMemory(scope, rememberRecent(readPickerMemory(scope), recentKey(state.billing, state.type, id)));
  const pickModel = (m: ComposerModel) => { used(m.id); composer.dispatch({ type: "model", value: m.id }); closeSheet(); };
  const recent = useMemo(() => recentModels(memory.recent, state.billing, state.type, offered), [memory.recent, state.billing, state.type, offered]);
  /* Every Studio row is priced where the composer stands (its picks, the project's aspect, its references,
     one take): the list's own rates cover the untouched composer; anything else is one read of the engines
     route's list, priced there, while the sheet is open. It quotes nothing and reserves nothing. */
  const priceAt = useMemo<PriceAt>(() => ({ aspect: composer.project?.aspect, picks: state.picks, references: state.references, seconds: state.seconds, takes: state.count }),
    [composer.project?.aspect, state.picks, state.references, state.seconds, state.count]);
  const priceKey = rateQuery(priceAt);
  const [sheetRates, setSheetRates] = useState<SheetRates | null>(null);
  const wantsRates = sheet && state.billing === "workspace" && needsPricedRead(offered, priceAt);
  const ratesKey = sheetRates?.key ?? null;
  useEffect(() => {
    if (!wantsRates || ratesKey === priceKey) return;
    let live = true;
    void scopedFetch(`/api/workbench/engines?${priceKey}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error("unpriced"); return r.json(); })
      .then((reply) => { if (live) setSheetRates(sheetRatesFrom(priceKey, reply)); })
      /* An unread price leaves those rows "priced on Generate"; the next opening asks again. */
      .catch(() => { if (live) setSheetRates({ key: priceKey, models: {}, audio: null, failed: true }); });
    return () => { live = false; };
  }, [wantsRates, ratesKey, priceKey, scopedFetch]);
  const rates = sheetRates?.key === priceKey ? sheetRates : null;
  const readingRates = wantsRates && !rates;
  const priceOf = (m: ComposerModel) => rowPrice(m, memory.quoted, priceAt, rates, readingRates);
  /* A connected quote the composer was actually given becomes that model's "last quote"; nothing here asks for one. */
  const connectedCredits = state.billing === "connected" && model?.connected ? composer.credits : null;
  const quotedAt = [model?.durations?.length ? `${settings.duration} s` : null, model?.resolutions?.length ? settings.resolution : null].filter(Boolean).join(" · ");
  const quotedId = model?.id ?? null;
  useEffect(() => {
    if (connectedCredits == null || !quotedId) return;
    const stored = readPickerMemory(scope);
    const next = rememberQuote(stored, quotedId, { credits: connectedCredits, at: Date.now(), ...(quotedAt ? { detail: quotedAt } : {}) });
    if (next !== stored) writePickerMemory(scope, next);
  }, [connectedCredits, quotedId, quotedAt, scope]);
  const [wellError, setWellError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [filter, setFilter] = useState<Filter>("All");
  const anchored = state.references.some((r) => r.kind === "video") || (state.type === "video" && state.references.length > 0);
  const enhancer = useEnhancer({
    prompt: state.prompt, mode: state.type as EnhanceMode, model: model?.id ?? null,
    anchored, editing: state.type === "image" && state.references.length > 0,
  });

  const drop = useCallback(async (id: string) => {
    setWellError(null);
    try {
      const asset = await resolveGenInput(id, scope);
      if (asset.kind !== "image" && asset.kind !== "video") throw new Error("References are images and videos.");
      dispatchComposer({ type: "addReference", value: { key: asset.key, id: asset.id, origin: asset.origin, kind: asset.kind, name: asset.name, url: asset.url } });
    } catch (error) {
      setWellError(error instanceof Error ? error.message : "This file cannot be used as a reference.");
    }
  }, [scope, dispatchComposer]);

  /* Words and recipes handed over from elsewhere in the shell. Crew › Open in
     Gen and Soul ID leave words (and a model) in session storage; Recreate
     posts a take's whole recipe by letter, so a Gen that is already open takes
     it too. Nothing runs either way: the button prices what arrived. */
  const [recipe, setRecipe] = useState<RecipeCard | null>(null);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const recipeEpoch = useRef(0);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; });
  const owner = session.owner;
  const { dismiss: dismissEnhanced, auto: autoNow, setAuto } = enhancer;
  const autoWas = useRef(autoNow);
  useEffect(() => { autoWas.current = autoNow; });
  const applyPreset = useCallback((preset: GenPreset) => {
    const epoch = ++recipeEpoch.current;
    setMode("compose");
    /* New words replace the old: an enhancement of the old words must not be what Generate sends. */
    if (!preset.settingsOnly) dismissEnhanced();
    if (!preset.from) {
      if (preset.type) dispatchComposer({ type: "type", value: preset.type });
      if (preset.model) dispatchComposer({ type: "model", value: preset.model });
      dispatchComposer({ type: "prompt", value: preset.prompt });
      setRecipe(null);
      setPresetNote(preset.note ?? null);
      return;
    }
    const previous = latest.current;
    const settingsOnly = Boolean(preset.settingsOnly);
    const type = preset.type ?? previous.type;
    const refs = settingsOnly || type === "audio" ? [] : preset.references ?? [];
    /* The connected account is the owner's; anyone else recreates on this workspace's engines, and their own engine choice stands. */
    const billing: BillingSource = preset.billing === "connected" && owner ? "connected" : "workspace";
    const lost = preset.billing === "connected" && billing !== "connected";
    /* The shot setup lands on the chips, and comes back out of the words it was written into. */
    const shot = cleanSetup(preset.shotSpec);
    dispatchComposer({
      type: "recipe",
      value: {
        type, billing, picks: preset.picks ?? {}, sound: preset.sound, shot,
        ...(lost ? {} : { model: preset.model }),
        ...(settingsOnly ? {} : { prompt: withoutSetup(preset.prompt, shot), references: [] }),
      },
    });
    /* A take made raw on the account is recreated raw, one enhanced there is enhanced there again. */
    const autoBefore = autoWas.current;
    const autoMoved = billing === "connected" && preset.enhance !== undefined && preset.enhance !== autoBefore;
    if (autoMoved) setAuto(preset.enhance!);
    setPresetNote(null);
    setRecipe({ preset, previous, autoBefore: autoMoved ? autoBefore : null, epoch, refs: { total: refs.length, reading: refs.length > 0, missing: [], renumbered: [], frames: false } });
    if (!refs.length) return;
    /* Every reference is read again in this workspace. The ones still here keep the take's order; the words
       are renumbered to match them, and the ones that are gone keep citations of their own (recipe › retagRecipe). */
    void Promise.allSettled(refs.map((r) => resolveGenInput(`${r.origin}:${r.id}`, scope))).then((results) => {
      if (recipeEpoch.current !== epoch) return;
      const assets = results.map((result) => (result.status === "fulfilled" ? result.value : null));
      const usable = assets.map((asset) => (asset && (asset.kind === "image" || asset.kind === "video") ? { ...asset, kind: asset.kind } : null));
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
          ? { tag: null, kind: assets[i]!.kind, origin: r.origin, gone: false, reason: "References are images and videos." }
          : { tag: tags.now[i], kind: kinds[i], origin: r.origin, gone: true, reason: result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "Not found in this workspace." });
      });
      if (tags.prompt !== latest.current.prompt) dispatchComposer({ type: "prompt", value: tags.prompt });
      /* On this workspace's credits a first or last frame is sent as a plain reference (the composer's roles come from the kind). */
      const frames = billing === "workspace" && usable.some((asset, i) => asset && /first_frame|last_frame/.test(refs[i].role ?? ""));
      setRecipe((now) => (now?.epoch === epoch ? { ...now, refs: { total: refs.length, reading: false, missing, renumbered, frames } } : now));
    });
  }, [scope, owner, dispatchComposer, dismissEnhanced, setAuto]);
  useEffect(() => {
    try {
      const found = readGenPreset(sessionStorage.getItem(GEN_PRESET_KEY));
      if (found) { sessionStorage.removeItem(GEN_PRESET_KEY); sendRecipe(found); }
    } catch { /* the preset is a convenience */ }
  }, []);
  useRecipeInbox(applyPreset);
  const undoRecipe = () => {
    if (!recipe) return;
    recipeEpoch.current++;
    dispatchComposer({ type: "restore", value: recipe.previous });
    dismissEnhanced();
    if (recipe.autoBefore !== null) setAuto(recipe.autoBefore);
    setRecipe(null);
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
  /* A carried identity that is no longer on the account is dropped, never sent. */
  const wantedSoul = recipe?.preset.picks?.soulId ?? null;
  const heldSoul = state.picks.soulId ?? null;
  const identities = characters.list;
  useEffect(() => {
    if (!wantedSoul || heldSoul !== wantedSoul || !identities) return;
    if (!identities.some((c) => c.soulId === wantedSoul && c.status !== "training" && c.status !== "failed")) dispatchComposer({ type: "pick", value: { soulId: undefined } });
  }, [wantedSoul, heldSoul, identities, dispatchComposer]);
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
  /* Gen's film vocabulary: the chips under Direction, and `#` in the words. */
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const setShot = useCallback((value: FilmSetup) => dispatchComposer({ type: "shot", value }), [dispatchComposer]);
  const setPrompt = useCallback((value: string) => dispatchComposer({ type: "prompt", value }), [dispatchComposer]);
  const typeahead = useFilmTypeahead({ type: state.type, prompt: state.prompt, setup: state.shot, textarea: promptBox, onPrompt: setPrompt, onSetup: setShot });

  /* The Library's `+`, a right-click or a drop on any page lands here as a reference. */
  const inbox = useCallback((letter: { id: string }) => { void drop(letter.id); }, [drop]);
  useReferenceInbox(inbox);

  /* Auto also asks a connected model whose schema declares enhance_prompt to enhance on the account (FINAL_SPEC §4). */
  const enhanceAuto = enhancer.auto;
  useEffect(() => { dispatchComposer({ type: "enhance", value: enhanceAuto }); }, [enhanceAuto, dispatchComposer]);

  /* A recreated take is not sent half-read: while its references or the account's identities are still being
     read, the composer holds a recipe without them, and a price for that is not the take's price. A citation of
     a reference that is gone holds it too, until a reference fills the slot or the words drop it. */
  const soulReading = Boolean(wantedSoul) && heldSoul === wantedSoul && wantsCharacters && !identities;
  const orphans = recipe && !recipe.refs.reading
    ? recipe.refs.missing.filter((m) => m.gone && m.tag && cites(state.prompt, m.tag)
      && state.references.filter((r) => r.kind === m.kind).length < Number(m.tag.replace(/\D/g, "")))
    : [];
  const orphan = orphans[0];
  const recipeWait = !recipe ? null
    : recipe.refs.reading ? "Reading the take’s references…"
    : soulReading ? "Reading the account’s identities…"
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


  const results = useMemo(() => {
    const media = FILTER_MEDIA[filter];
    return items.filter((entry) => entry.take.kind === "GEN" && (media === "all" || entry.media === media));
  }, [items, filter]);
  const running = ws.state.gen;
  const takesReferences = state.type !== "audio" && (state.billing === "workspace" || Boolean(model?.referenceRoles?.length));
  /* The well names each reference the way the engine counts it: @Image1, @Video1, within its own kind. */
  const wellTags = referenceTags(state.references.map((r) => r.kind));
  /* The Direction box takes media: pictures and videos become references when this model takes them; the rest stays in the Library. */
  const attachToGen = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const used: string[] = [], kept = [...unreadable];
    for (const m of media) {
      if (takesReferences && (m.kind === "image" || m.kind === "video")) { dispatchComposer({ type: "addReference", value: { key: m.key, id: m.id, origin: m.origin, kind: m.kind, name: m.name, url: m.url } }); used.push(m.name); }
      else kept.push(m.name);
    }
    return [used.length ? `${used.join(", ")} ${used.length === 1 ? "is a reference" : "are references"}.` : "", keptNote(kept, takesReferences ? "references are pictures and video." : `${model?.label ?? "this model"} takes a prompt only.`) ?? ""].filter(Boolean).join(" ") || null;
  };
  const footer = [settings.ratio, model?.durations?.length ? `${settings.duration} s` : null, "Saved to your takes"].filter(Boolean).join(" · ");

  /* What Gen holds against what the recreated take was made with. */
  const chips = recipe ? recipeChips({
    preset: recipe.preset, type: state.type, billing: state.billing, model, models: composer.models, settings, owner: Boolean(owner),
    reading: blocked === READING_MODELS || blocked === READING_ACCOUNT, blocked: model ? null : blocked, identities: characters.list,
  }) : [];
  const refs = recipe?.refs ?? null;
  const setup = recipe?.preset.shotSpec ? setupLabels(recipe.preset.shotSpec) : [];
  const carried = refs ? refs.total - refs.missing.length : 0;
  const gone = refs?.missing.filter((m) => m.gone) ?? [];
  const unused = refs?.missing.filter((m) => !m.gone) ?? [];
  const from = (m: MissingReference) => (m.origin === "upload" ? "upload" : "take");
  const notes = recipe && !recipe.hidden ? [
    ...chips.filter((c) => c.state === "changed" && c.why).map((c) => ({ key: c.key, label: c.label, text: c.why!, alert: false })),
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
        {setup.length ? <li data-state="kept" data-chip="setup" data-testid="gen-recipe-setup" title={`Setup: ${setup.join(" · ")}`}>{setup.join(" · ")}</li> : null}
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

  const analysis = WORKFLOW_SURFACES["gen:analysis"][0];
  const tabs = (
    <div className="gx-seg gx-seg--fill" role="tablist" aria-label="Output">
      {ORDER.filter((t) => COMPOSER_TYPES.includes(t)).map((t) => (
        <button key={t} type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "compose" && state.type === t} onClick={() => { setMode("compose"); composer.dispatch({ type: "type", value: t }); }}><span>{TYPE_TAB[t]}</span></button>
      ))}
      <button type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "edit"} onClick={() => setMode("edit")} data-testid="gen-tab-edit"><span>Edit</span></button>
      <button type="button" role="tab" className="gx-seg-btn" aria-selected={mode === "analysis"} onClick={() => setMode("analysis")} data-testid="gen-tab-analysis"><span>Analysis</span></button>
    </div>
  );
  if (mode === "edit") {
    return (
      <div className="gx-gen gx-enter" data-testid="gen-view">
        <div className="gx-gen-col">
          <section className="gx-gen-card" aria-label="Output">{tabs}</section>
          <SeedanceEditHost scope={scope} project={project} onBack={() => setMode("compose")} />
        </div>
      </div>
    );
  }
  if (mode === "analysis") {
    return (
      <div className="gx-gen gx-enter" data-testid="gen-view">
        <div className="gx-gen-col">
          <section className="gx-gen-card" aria-label="Output">{tabs}</section>
          <WorkflowHost surface={analysis} scope={scope} project={project} />
        </div>
      </div>
    );
  }
  return (
    <div className="gx-gen gx-enter" data-testid="gen-view">
      <section className="gx-gen-card" aria-label="Composer">
        {tabs}
        {recipeCardView}

        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">01 / Direction</span>
          {presetNote ? <p className="gx-gen-note" role="status" data-testid="gen-preset-note">{presetNote}</p> : null}
          <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToGen} testId="gen-attach"><textarea ref={promptBox} className="gx-textarea" aria-label="Direction" rows={5} placeholder={PLACEHOLDER[state.type]} value={state.prompt}
            onChange={(e) => { composer.dispatch({ type: "prompt", value: e.target.value }); typeahead.track(e.target); }} {...typeahead.inputProps} data-testid="gen-prompt" />{typeahead.list}</PromptAttach>
          <FilmChips scope={scope} type={state.type} setup={state.shot} onChange={setShot} />
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
              <span className="gx-eyebrow" data-functional-label="">Enhanced · {ENHANCER_LABEL[enhancer.provider ?? "higgsfield"]}{enhancer.charged != null ? ` · ${enhancer.charged.toLocaleString("en-US")} cr` : ""}</span>
              <p>{enhancer.enhanced}</p>
              <div className="gx-enhanced-actions">
                <button type="button" className="gx-hbtn" onClick={() => { composer.dispatch({ type: "prompt", value: enhancer.enhanced! }); enhancer.dismiss(); }} data-testid="enhanced-use">Use this</button>
                <button type="button" className="gx-hbtn" onClick={enhancer.dismiss} data-testid="enhanced-keep">Keep mine</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">02 / Model</span>
          <button ref={modelButton} type="button" className="gx-model" aria-haspopup="dialog" aria-expanded={sheet} onClick={openSheet} data-testid="gen-model">
            <span className="gx-tool-tag" aria-hidden="true">{(model?.label ?? "—").slice(0, 2).toUpperCase()}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="gx-model-name">{model?.label ?? "Choose a model"}</span>
              <span className="gx-model-sub">{state.billing === "connected" ? "Higgsfield catalogue" : "Studio engine"}</span>
            </span>
            <span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>▾</span>
          </button>
        </div>

        {model?.promptOnly ? <p className="cw-dim" data-testid="gen-prompt-only">{model.label} takes a prompt only — no references.</p> : null}
        {takesReferences ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">References</span>
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
                  <span className="gx-ref-thumb">{r.kind === "image" || r.kind === "video" ? <LazyMedia url={r.url} kind={r.kind} alt="" name={r.name} className="gx-lazy" /> : null}</span>
                  {model?.connected && (model.referenceRoles?.length ?? 0) > 1 ? (
                    <button type="button" className="bz-role" title="Click to cycle the role" data-testid="gen-ref-role" onClick={() => { const roles = model.referenceRoles!; const at = roles.indexOf(r.role ?? roles[0]); composer.dispatch({ type: "referenceRole", key: r.key, role: roles[(at + 1) % roles.length] }); }}>{r.role ?? model.referenceRoles![0]}</button>
                  ) : null}
                  <span className="gx-ref-name">{wellTags[i]} · {r.name}</span>
                  <button type="button" className="gx-ref-x" aria-label={`Remove ${r.name}`} onClick={() => composer.dispatch({ type: "removeReference", key: r.key })}>×</button>
                </span>
              )) : <span className="gx-well-hint">Drag an asset here from the Library.</span>}
              {!shell.wide ? <button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")}>Open Library</button> : null}
            </div>
            {wellError ? <p className="gx-gen-error" role="alert">{wellError}</p> : null}
          </div>
        ) : null}

        {model?.soulId ? (
          <div className="gx-gen-row" data-testid="gen-identity">
            <label className="gx-eyebrow" htmlFor="gx-identity" data-functional-label="">Identity</label>
            <select id="gx-identity" className="gx-select" value={settings.soulId ?? ""} onChange={(e) => composer.dispatch({ type: "pick", value: { soulId: e.target.value } })} data-testid="gen-identity-pick">
              <option value="">No identity · prompt only</option>
              {(characters.list ?? []).map((c) => <option key={c.soulId} value={c.soulId} disabled={c.status === "training" || c.status === "failed"}>{c.name}{c.status && c.status !== "ready" ? ` · ${c.status}` : ""}</option>)}
            </select>
            <p className="gx-hint" data-testid="gen-identity-note">
              {characters.note}{" "}
              <button type="button" className="cw-link" onClick={() => shell.goSuite("studio", "cast")}>Build identity in Cast</button>
            </p>
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
        {model?.resolutions?.length ? (
          <div className="gx-gen-row">
            <span className="gx-eyebrow" data-functional-label="">Resolution</span>
            <div className="gx-chips" role="group" aria-label="Resolution">
              {model.resolutions.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={settings.resolution === r} onClick={() => composer.dispatch({ type: "pick", value: { resolution: r } })}>{r}</button>)}
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

        {state.notice ? <p className="gx-gen-note" role="status">{state.notice}</p> : null}
        {composer.projectNotice ? <p className="gx-gen-note" role="status">{composer.projectNotice}</p> : null}
        {block ? <p className="gx-reason" id="gx-gen-blocked" data-testid="gen-blocked">{block}</p> : null}
        {/* The takes stepper and the billing line sit outside the sticky block: on a phone the
            sticky Generate (GLASS_SPEC §3) is the button and its one-line foot, nothing taller. */}
        <div className="gx-gen-takes" data-testid="gen-takes">
            <span className="gx-hint">Takes</span>
            <div className="gx-stepper" role="group" aria-label="Takes per generate">
              <button type="button" aria-label="Fewer" disabled={state.count <= 1} onClick={() => composer.dispatch({ type: "count", value: state.count - 1 })}>–</button>
              <span data-testid="gen-takes-count">{state.count}</span>
              <button type="button" aria-label="More" disabled={state.count >= TAKES_MAX} onClick={() => composer.dispatch({ type: "count", value: state.count + 1 })}>+</button>
            </div>
        </div>
        <div className="gx-gen-cta">
          <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(block) || submitting} aria-describedby={block ? "gx-gen-blocked" : undefined} onClick={generate} data-testid="gen-generate">
            {submitting ? "Submitting…" : recipeWait ? "Generate" : buttonLabel}
          </button>
          <p className="gx-gen-foot">{footer}{enhancer.auto && enhancer.enhanced ? " · enhanced first" : ""}{model?.enhanceable && enhancer.auto && !isRawPrompt(state.prompt) ? " · enhanced on Higgsfield" : ""}</p>
        </div>
        <p className="gx-gen-foot">{composer.wording}</p>
      </section>

      <section className="gx-gen-results" aria-label="Results">
        <div className="gx-gen-results-head">
          <span className="gx-panel-title">Results</span>
          <div className="gx-chips" role="group" aria-label="Result kind">
            {FILTERS.map((f) => <button key={f} type="button" className="gx-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
          </div>
        </div>
        <VirtualItems
          className="gx-gen-grid" items={results} getKey={(entry) => entry.take.id} layout={{ minColumnWidth: 180 }} gap={12} estimateRowHeight={190} scroll="ancestor"
          before={<>
          {running ? (
            <div className="gx-asset" data-testid="gen-running">
              <span className="gx-asset-thumb gx-running"><span className="gx-ring" style={{ background: `conic-gradient(var(--gx-accent) ${Math.max(2, Math.min(100, running.pct ?? 0))}%, var(--gx-hair) 0)` }} aria-hidden="true" /></span>
              <span className="gx-asset-name">{running.name ?? "Rendering"}</span>
              <span className="gx-asset-meta">{running.label ?? "Running"}</span>
            </div>
          ) : null}
          {composer.connectedEnhanced ? (
            <p className="gx-gen-note" role="status" data-testid="gen-enhanced-on-account"><span className="gx-eyebrow">Enhanced on the account</span> {composer.connectedEnhanced.slice(0, 400)}</p>
          ) : null}
          </>}
          renderItem={(entry) => (
            <div className="gx-asset" data-selected={ws.state.selKind === "take" && ws.state.selId === entry.take.id}>
              <button type="button" className="gx-asset-thumb" title={entry.take.name} draggable data-ctx={`asset:${entry.take.id}`} {...previewAttrs(entryPreview(entry))}
                onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => { ws.dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } }); shell.openInspector(); }}>
                {entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} className="gx-lazy" /> : entry.media === "audio" ? <span className="gx-badge">AUDIO</span> : null}
              </button>
              <span className="gx-asset-name">{entry.take.name}</span>
              <span className="gx-asset-meta">{entry.take.meta}</span>
            </div>
          )}
        />
        {!running && !results.length ? <p className="gx-empty">{project ? "Nothing generated in this project yet. What you make lands here, in Takes, and in Library › Assets." : "Open a project, or generate — the composer files a first project for you."}</p> : null}
      </section>

      {/* The veil leaves the stage island: a `backdrop-filter` ancestor would contain its `position: fixed`
          (the sheet then rises inside the scroll region, under the phone's tab bar). It lands on the shell
          root so the tokens still reach it. */}
      {sheet ? createPortal(
        <div className="gx-veil" onClick={closeSheet} data-testid="model-sheet-veil">
          <ModelSheet label={`${TYPE_TAB[state.type]} models`} groups={groups} billing={state.billing} onBilling={(value) => composer.dispatch({ type: "billing", value })}
            offered={offered} recent={recent} selectedId={model?.id ?? null} priceOf={priceOf}
            loading={blocked === READING_MODELS || blocked === READING_ACCOUNT}
            empty={!offered.length && blocked ? blocked : state.billing === "connected" ? "No Higgsfield models for this output. Connect the account in Workspace › Engines, or choose a Studio engine." : "No Studio engine is connected for this output."}
            emptyActions={state.billing === "connected"
              ? [{ label: "Use Studio engines", onClick: () => composer.dispatch({ type: "billing", value: "workspace" }), testId: "gen-model-use-studio" },
                 ...(session.owner ? [{ label: "Open Workspace › Engines", onClick: () => { setSheet(false); shell.goWorkspace("engines"); }, testId: "gen-model-open-engines" }] : [])]
              /* The engine list itself is missing (a failed read): read it again. */
              : composer.models.some((m) => m.type !== "audio") ? [] : [{ label: "Try again", onClick: composer.retryEngines, testId: "gen-model-retry" }]}
            onPick={pickModel} onClose={closeSheet} />
        </div>,
        document.querySelector(".gx") ?? document.body,
      ) : null}
    </div>
  );
}
