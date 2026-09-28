"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import LazyMedia from "@/components/LazyMedia";
import { VirtualItems, smoothScrollIntoView } from "@/components/workspace/VirtualItems";
import { previewAttrs } from "@/lib/preview";
import { StudioRequestError, studioRequest } from "@/components/workbench/GenerationDialog";
import { trailLine } from "@/lib/approval";
import { timeAgo } from "@/lib/format";
import { BOARD_MODELS, stillShape, type BoardModel } from "@/lib/production/boards";
import { getModel } from "@/lib/models";
import { addTakeToCut, entryAsset } from "@/lib/production/sequence";
import { sendToRig } from "@/lib/production/rig-build";
import { movedOn, poll } from "@/lib/poll";
import { failureKind } from "@/lib/jobState";
import { activeMediaJob } from "@/lib/workbench/job-recovery";
import { isVariation, takeLabel } from "@/lib/variations";
import { SECTION_EVENT } from "@/lib/shell/production-tools";
import { publishGallery } from "@/lib/shell/preview-bridge";
import { useShell } from "@/lib/shell/state";
import type { SelectReason } from "@/lib/shell/asset-link";
import { useHandedTake } from "@/lib/shell/take-handover";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { entryBatch, entryFace, findProjectTake, libraryView, projectLibraryState, refreshProjectLibrary, reviewProjectTake, useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { DESK_FILTERS, nextReview, reviewSaid, takeChip, type DeskFilter, type ReviewState } from "@/lib/workspace/takes";
import { DESK_KINDS, countLabel, decidedBatches, deskCounts, deskEmpty, deskItems, deskTakes, inDesk, openable, reviewable, rigShotOrder, stepTake, type DeskItem, type DeskKind } from "@/lib/workspace/takes-desk";
import { LibraryMore } from "../LibraryMore";
import { useWorkspace } from "@/lib/workspace/state";
import { SeedanceEditHost } from "../tools/SeedanceEditHost";
import { AssetNextActions, revealNext } from "../AssetNextActions";
import { Chip, LoadBanner, TakeSkeletons, TakeTile } from "../TakeTile";
import { KIND_DOT } from "../icons";
import { TranscribePanel } from "./TranscribePanel";
import { useStageFacts } from "./use-stage-facts";
import { useStageQuotes } from "./use-stage-quotes";

const EDIT_LIMIT = 4000;
type Generation = { id: string; status: string; error?: string | null };

/** The status chips' dots: the tile chips' own tones. */
const STATUS_DOT: Record<DeskFilter, string> = { all: "", review: "rgba(235, 235, 245, .6)", picked: "var(--gx-accent)", approved: "var(--gx-done)", changes: "var(--gx-waiting)", held: "var(--gx-waiting)", failed: "var(--gx-failed)" };
const KIND_CHIP_DOT: Record<DeskKind, string> = { video: KIND_DOT.Video, image: KIND_DOT.Images, audio: KIND_DOT.Audio, upload: KIND_DOT.Uploads };
/** The review buttons, and what each says once it is the take's state (pressed again, it clears). */
const REVIEWS = [
  { state: "picked", press: "Pick", done: "Picked" },
  { state: "approved", press: "Approve", done: "Approved" },
  { state: "changes", press: "Request changes", done: "Changes requested" },
] as const;

/** The re-edit request for a still: the take as the reference, the instruction, and the order to change nothing else. */
export function reEditRequest(entry: LibraryEntry, instruction: string, model: BoardModel, productionProjectId: string, ratio: string, extras: ({ genId: string } | { uploadId: string })[] = []): GenerationBodyInput {
  const source = entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId };
  return {
    prompt: `Edit the reference image: ${instruction.trim()}\n\nChange only what is asked. Keep the composition, framing, lighting, people and every other detail exactly as they are.${extras.length ? ` The first image is the one to edit; the ${extras.length === 1 ? "other image shows" : `other ${extras.length} images show`} what to bring into it.` : ""}`.slice(0, 10_000),
    kind: "image", model: { id: model }, mapping: { shotId: "", productionProjectId }, ...stillShape(getModel(model), ratio), duration: 5,
    references: [{ ...source, role: "reference_image" }, ...extras.map((x) => ({ ...x, role: "reference_image" as const }))], firstFrameAssetId: "",
  };
}

/** Why a take cannot open in the editor yet, and what happens next (the card says the same). */
export function notOpenWords(entry: LibraryEntry): string {
  const { take } = entry;
  const face = entryFace(entry);
  /* What starts a held take depends on what holds it. Credits start a shortfall; a block of its own (a cap, a moved or
     incomplete price, a token's ceiling: lib/held.ts writes it on the row) is lifted otherwise, in the row's own next
     words when it has them. */
  const said = take.detail ?? take.reason ?? "";
  const kind = failureKind(said);
  const next = !said || kind === "balance" ? " It starts on its own when credits arrive."
    : kind === "cap" ? " It starts on its own when the cap allows it or an admin raises the cap."
    : /token's .*ceiling/.test(said) ? " It starts on its own when the token's monthly ceiling resets."
    : take.detail && take.reason && take.detail.startsWith(take.reason) ? ` ${take.detail.slice(take.reason.length).trim()}`.trimEnd() : "";
  return face === "failed" || face === "stopped" ? `${take.name} did not render${take.reason ? ` · ${take.reason.replace(/\.$/, "")}` : ""}.`
    : face === "held" ? `${take.name} is held${take.reason ? ` · ${take.reason.replace(/\.$/, "")}` : ""}.${next}`
    : face === "live" ? `${take.name} is still ${take.stage === "queued" ? "queued" : "rendering"}; it opens here when it lands.`
    : face === "unavailable" ? `${take.name} rendered, but its stored copy is not here yet. Refresh on its card reads it again.`
    : "This file has no picture or sound to edit.";
}

/** Who picked, approved or sent a take back, and when; nothing for a take waiting for review. */
export function reviewTrail(entry: LibraryEntry): string | null {
  if (entry.asset.origin !== "generation" || entry.take.status === "review") return null;
  const g = entry.asset.value;
  const back = entry.take.status === "changes" && g.reviewBy ? `Changes requested by ${g.reviewBy}` : "";
  const text = [back, trailLine({ pickedBy: g.pickedBy, pickedAt: g.pickedAt, approvedBy: g.approvedBy, approvedAt: g.approvedAt }, timeAgo)].filter(Boolean).join(" · ");
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}

const isHeading = (item: DeskItem) => item.type !== "take";
const runOf = (item: DeskItem) => (item.type === "take" ? item.run : item.key);

/**
 * Studio › Takes, the review desk every "Filed in Takes for review" points
 * at: every take of the project once, with a status filter (All / Needs
 * review / Picked / Approved / Changes / Held / Failed), kind chips and a
 * search; grouped by shot, then by the batch it was rendered in; a long
 * project is windowed and reads its next page as the list's end comes into
 * view. The selected take is picked, approved or sent back through the
 * existing review route, which records who; a video take opens in Seedance
 * Edit, a still is re-edited from an instruction priced before it renders, a
 * sound gets its transcript (priced first), and any take goes to the Timeline.
 */
/** A re-edit the page can no longer read: where it goes if it renders, and that a failed one costs nothing. */
const REEDIT_LOST = "This re-edit can no longer be checked from here. If it renders, it lands in the library; a failed render is not billed.";

export function EditStage({ scope, projectId, items, onTimeline }: { scope: string; projectId: string; items: LibraryEntry[]; onTimeline: () => void }) {
  const draft = useDraftEditor(scope, projectId);
  /* The same store the shell reads `items` from: Load more and Try again here fill Takes and the Library together. */
  const library = useProjectLibrary(scope, projectId);
  const { toast, state } = useWorkspace();
  const shell = useShell();
  const { live: liveShell } = shell;
  const project = draft.project;
  useStageFacts("takes", project);

  /* The desk: a status, a kind and a search, over every take grouped by shot and batch. */
  const [filter, setFilter] = useState<DeskFilter>("all");
  const [kind, setKind] = useState<DeskKind | null>(null);
  const [typed, setTyped] = useState("");
  const query = useDeferredValue(typed);
  const shots = useMemo(() => rigShotOrder(project), [project]);
  const desk = { filter, kind, query };
  const decided = useMemo(() => decidedBatches(items), [items]);
  const all = useMemo(() => deskTakes(deskItems(items, shots, decided)), [items, shots, decided]);
  const rows = useMemo(() => deskItems(items.filter((e) => inDesk(e, { filter, kind, query })), shots, decided), [items, shots, decided, filter, kind, query]);
  /* The takes as the desk shows them, whole and in order: the viewer walks this list, not the tiles a windowed grid has mounted. */
  const shownTakes = useMemo(() => deskTakes(rows), [rows]);
  const shownIds = useMemo(() => new Set(shownTakes.map((e) => e.take.id)), [shownTakes]);
  useEffect(() => publishGallery("takes", { projectId, entries: shownTakes }), [projectId, shownTakes]);
  const counts = useMemo(() => deskCounts(items, kind, query), [items, kind, query]);
  const narrowed = filter !== "all" || kind != null || Boolean(query.trim());
  const clear = () => { setFilter("all"); setKind(null); setTyped(""); };

  /* The take open here is the shell's selected take (lib/shell/state.tsx › selectAsset): a tile, Previous/Next, the Library, the
     viewer's arrows and a link all move the one selection, so the Inspector and the desk always show the same take. A take sent
     here (Viral's Send to Edit, the Library, a link) opens first — that take and no other: until it is loaded the page says so. */
  const picked = state.selKind === "take" ? state.selId : null;
  const chosen = picked ? items.find((e) => e.take.id === picked) ?? null : null;
  const [lost, setLost] = useState<string | null>(null);
  /* A library that did not load is not an answer: its banner says so, and Try again searches again. */
  const readFailed = library.state.status === "error";
  const finding = Boolean(picked) && !chosen && lost !== picked && !readFailed;
  /* Nothing opens by itself: the desk shows the takes first, and the editor opens on the one chosen. */
  const entry = chosen && openable(chosen) ? chosen : null;
  /* Not in the loaded range yet: older pages come in until it is found, or it is not in the project. */
  useEffect(() => {
    if (!finding || !picked) return;
    let live = true;
    void findProjectTake(scope, projectId, picked).then((found) => {
      const now = projectLibraryState(scope, projectId);
      if (live && !found && now.status === "ready" && !now.error) setLost(picked);
    });
    return () => { live = false; };
  }, [finding, picked, scope, projectId]);
  /* A take handed over from another page is brought into view once, the way a pick is. */
  const [focus, setFocus] = useState(picked);
  const focusOn = project && focus && focus === picked ? (entry?.take.id === focus ? "take" : !chosen ? (finding ? "finding" : "lost") : null) : null;
  useEffect(() => {
    if (!focusOn) return;
    const frame = requestAnimationFrame(() => {
      const panel = document.querySelector("[data-section='edit-panel']");
      if (!panel) return;
      panel.scrollIntoView({ block: "start" });
      if (focusOn !== "finding") setFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusOn]);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState<BoardModel>(BOARD_MODELS[0].id);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /* Another take, from wherever it was chosen: the last one's message does not carry over (its price is keyed on the request). */
  const [shownTake, setShownTake] = useState(picked);
  if (shownTake !== picked) { setShownTake(picked); setError(""); }
  const open = useCallback((e: LibraryEntry, scroll = true, reason: SelectReason = "open") => {
    if (!openable(e)) { toast(notOpenWords(e)); return; }
    liveShell().selectAsset(e.take.id, { reason });
    /* Smoothly, from wherever the desk is: from the end of a windowed grid the grid holds its corrections until the editor is in view. */
    if (scroll) requestAnimationFrame(() => smoothScrollIntoView(document.querySelector("[data-section='edit-panel']")));
  }, [toast, liveShell]);
  const step = (dir: 1 | -1) => {
    const next = stepTake(all, shownIds, entry?.take.id ?? null, dir);
    if (next) open(next, false, "step");
  };
  const prev = entry ? stepTake(all, shownIds, entry.take.id, -1) : null;
  const next = entry ? stepTake(all, shownIds, entry.take.id, 1) : null;
  /* Back to the takes: the take closes and its card comes into view — its tile if it is on the page, else the
     windowed grid brings its row in (centred, clear of the phone's tab bar). A reveal is dropped once it has
     been applied, so a grid that is windowed again later does not jump back to it. */
  const [reveal, setReveal] = useState<{ key: string; n: number } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => setReveal(null), 500);
    return () => clearTimeout(timer);
  }, [reveal]);
  const backToGrid = (id: string) => {
    /* Only while it is still the selected take: a selection made since (the Library, a link) stands. */
    liveShell().selectAsset(null, { reason: "close", ifCurrent: id }); setFocus(null);
    requestAnimationFrame(() => {
      const tile = document.querySelector(`[data-testid="takes-grid"] [data-take="${CSS.escape(id)}"]`);
      if (tile) tile.scrollIntoView({ block: "center" });
      else if (shownIds.has(id)) setReveal((r) => ({ key: id, n: (r?.n ?? 0) + 1 }));
      else document.querySelector("[data-section='takes']")?.scrollIntoView({ block: "start" });
    });
  };

  /* The Library's tools: Needs review narrows the desk to it; Seedance Edit and Re-edit open the newest take they work on. */
  useEffect(() => {
    const onSection = (event: Event) => {
      const section = (event as CustomEvent<string>).detail;
      if (section === "review") { setFilter("review"); return; }
      const media = section === "video" ? "video" : section === "image" ? "image" : null;
      if (!media || entry?.media === media) return;
      const newest = all.find((e) => e.media === media && openable(e));
      if (newest) open(newest, false, "pick");
    };
    window.addEventListener(SECTION_EVENT, onSection);
    return () => window.removeEventListener(SECTION_EVENT, onSection);
  }, [all, entry, open]);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* Review: the existing route records who picked, approved or sent it back; every grid shows it at once. */
  const [reviewing, setReviewing] = useState<{ id: string; state: Exclude<ReviewState, ""> } | null>(null);
  const [reviewError, setReviewError] = useState<{ id: string; message: string } | null>(null);
  const review = async (target: LibraryEntry, pressed: Exclude<ReviewState, "">) => {
    if (!reviewable(target) || reviewing) return;
    const to = nextReview(target.take.status, pressed);
    setReviewing({ id: target.take.id, state: pressed }); setReviewError(null);
    try {
      await reviewProjectTake(scope, projectId, target.take.sourceId, to);
      toast(reviewSaid(target.take.name, to));
    } catch (cause) {
      if (alive.current) setReviewError({ id: target.take.id, message: cause instanceof Error ? cause.message : "The review was not saved." });
    } finally {
      if (alive.current) setReviewing(null);
    }
  };

  /* Pictures attached to the instruction ride as further references: what to bring into the still. */
  const [extras, setExtras] = useState<{ id: string; name: string; ref: { genId: string } | { uploadId: string } }[]>([]);
  const attachToEdit = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const pictures = media.filter((m) => m.kind === "image").slice(0, 3);
    setExtras((prev) => [...prev, ...pictures.filter((m) => !prev.some((x) => x.id === m.key)).map((m) => ({ id: m.key, name: m.name, ref: m.origin === "generation" ? { genId: m.id } : { uploadId: m.id } }))].slice(0, 3));

    return [pictures.length ? `${pictures.map((m) => m.name).join(", ")} ${pictures.length === 1 ? "goes" : "go"} with the edit as ${pictures.length === 1 ? "a reference" : "references"}.` : "", keptNote([...unreadable, ...media.filter((m) => !pictures.includes(m)).map((m) => m.name)], "an edit takes up to three reference pictures.") ?? ""].filter(Boolean).join(" ") || null;
  };
  const [pending, setPending] = useState<{ jobId: string; from: string } | null>(null);
  /** The last status read of the re-edit in flight failed; cleared by the next good one. */
  const [checking, setChecking] = useState("");
  const [made, setMade] = useState<{ genId: string; from: string } | null>(null);
  /* A take handed over while Takes is already open (the jobs tray's Open in Takes): the desk shows the shell's selection, so the
     take is already the one open (the tray selected it); the handover makes sure it is selected, brings it into view like one
     handed over on the way in, and clears a stale "not in this project". Its re-edit price follows the picked take on its own
     (useStageQuotes is keyed on the request), so there is no quote to clear. */
  useHandedTake((id) => { liveShell().selectAsset(id, { reason: "open" }); setFocus(id); setLost(null); setError(""); });

  /* A re-edit in flight: read at lib/poll's pace until it lands, then the Library shows it. */
  useEffect(() => {
    if (!pending) return;
    const moved = movedOn();
    const poller = poll({
      read: (signal) => studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(pending.jobId)}`, { signal, headers: { "X-Workbench-Scope": scope }, cache: "no-store" }),
      moved: ({ generation }) => moved(pending.jobId, generation.status),
      done: ({ generation }) => !activeMediaJob(generation),
      onValue: ({ generation }) => {
        if (!alive.current) return;
        setChecking("");
        if (activeMediaJob(generation)) return;
        setPending(null);
        if (generation.status === "succeeded") { setMade({ genId: generation.id, from: pending.from }); void refreshProjectLibrary(scope, projectId); toast("The re-edit is in the library"); }
        else setError(generation.error || "The re-edit did not render. A failed render is not billed.");
      },
      /* No longer on record for this person: asking again cannot help, and whether it was billed follows
         from whether it rendered. Anything else is said while it is asked again, later. */
      onError: (cause) => {
        if (!alive.current) return;
        if (!(cause instanceof StudioRequestError) || (cause.status !== 404 && cause.status !== 403)) {
          setChecking(cause instanceof StudioRequestError ? "Could not check this re-edit. Checking again shortly." : "The connection dropped. Checking again shortly.");
          return;
        }
        setPending(null); setChecking("");
        setError(REEDIT_LOST);
        return "stop";
      },
    });
    return () => poller.stop();
  }, [pending, scope, projectId, toast]);

  /* The card contract (components/graphite/TakeTile.tsx): skeletons while the first read is out, a banner if it failed. */
  const view = libraryView(library.state, items.length);
  const failed = view.banner?.tone === "error" ? view.banner : null;
  const request = entry?.media === "image" && project?.productionProjectId && instruction.trim()
    ? reEditRequest(entry, instruction, model, project.productionProjectId, project.aspect, extras.map((x) => x.ref)) : null;
  const pricing = useStageQuotes(scope, request ? { edit: { body: generationRequestBody(request) } } : {});
  const shown = pricing.quotes.edit;
  const sending = useRef(false);
  if (!project) return <p className="gx-empty" role="status">{draft.state.error ?? "Opening the takes…"}</p>;
  const render = async () => {
    if (shown?.credits == null || !entry || !request || pending || sending.current) return;
    sending.current = true;
    setBusy("Sending…"); setError("");
    try {
      const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, project.id, `reedit-${entry.take.sourceId}`), shown: shown.credits, request: { endpoint: "/api/generate", input: request } });
      if (outcome.state === "repriced") { pricing.reprice("edit", outcome.credits); setError(outcome.reason); return; }
      if (outcome.state === "refused") { setError(outcome.reason); return; }
      setPending({ jobId: outcome.jobId, from: entry.take.id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The re-edit could not be sent."); }
    finally { sending.current = false; setBusy(""); }
  };
  const toTimeline = (e: LibraryEntry) => {
    try { draft.onChange((p) => addTakeToCut(p, e)); void draft.ensureSaved(); toast(`${e.take.name} is in the cut`); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "It could not go on the timeline."); }
  };
  const sourceKey = entry ? `${entry.asset.origin === "generation" ? "generation" : "upload"}:${entry.take.sourceId}` : null;
  /* A take of a batch is named by its number too: the strip's siblings share one prompt. */
  const selectedBatch = entry ? entryBatch(entry) : undefined;
  const selectedTake = selectedBatch && typeof selectedBatch.batchId === "string" && isVariation(selectedBatch.variation) ? selectedBatch.variation : null;
  const blocked = !entry ? "Choose a take." : !project.productionProjectId ? "Save the project first." : !instruction.trim() ? "Write what should change." : null;
  const more = library.hasMore;
  const total = `${items.length.toLocaleString("en-US")}${more ? "+" : ""}`;
  const hint = view.skeletons ? "Reading this project…" : failed ? `${project.shots.length} in the cut`
    : narrowed ? `${shownIds.size.toLocaleString("en-US")} of ${total} · ${project.shots.length} in the cut`
    : `${total} in this project · ${project.shots.length} in the cut`;
  const chip = entry ? takeChip(entry.take) : null;
  const trail = entry ? reviewTrail(entry) : null;
  const judging = entry && reviewing?.id === entry.take.id ? reviewing : null;
  const reviewProblem = entry && reviewError?.id === entry.take.id ? reviewError.message : null;

  return (
    <div className="pd-stage gx-enter" data-testid="edit-stage">
      {failed ? <LoadBanner banner={failed} onRetry={library.refresh} testId="takes-error" /> : null}

      {entry ? (
        <>
          <section className="gx-gen-card pd-selected" aria-label={`Selected take: ${entry.take.name}`} data-section="edit-panel" data-testid="takes-selected">
            <div className="pd-row-head pd-selected-head">
              <span className="gx-eyebrow pd-selected-name" data-functional-label="" title={entry.take.name}>Selected · {selectedTake ? `${takeLabel(selectedTake)} · ` : ""}{entry.take.name}</span>
              {chip ? <span className="pd-selected-chip"><Chip {...chip} /></span> : null}
              <span className="gx-spacer" />
              <span className="pd-selected-step">
                <button type="button" className="gx-hbtn" disabled={!prev} onClick={() => step(-1)} aria-label="Previous take" data-testid="takes-prev">‹ Previous</button>
                <button type="button" className="gx-hbtn" disabled={!next} onClick={() => step(1)} aria-label="Next take" data-testid="takes-next">Next ›</button>
              </span>
            </div>
            {reviewable(entry) ? (
              <div className="pd-review" role="group" aria-label={`Review ${entry.take.name}`} data-testid="takes-review" aria-busy={judging ? true : undefined}>
                {REVIEWS.map((r) => {
                  const on = entry.take.status === r.state;
                  return (
                    <button key={r.state} type="button" className="gx-hbtn pd-review-btn" data-review={r.state} aria-pressed={on} disabled={Boolean(reviewing)}
                      title={on ? "Press again to take it back to Needs review" : undefined} onClick={() => void review(entry, r.state)} data-testid={`review-${r.state}`}>
                      {on ? r.done : r.press}
                    </button>
                  );
                })}
                {trail ? <span className="gx-hint pd-review-trail" data-testid="review-trail">{trail}</span> : null}
              </div>
            ) : (
              <p className="gx-hint pd-review-none" data-testid="review-none">{entry.asset.origin === "upload" ? "An upload is a source: it is used, not reviewed." : "Picked and approved once its picture is here."}</p>
            )}
            {reviewProblem ? <p className="gx-reason" role="alert" data-testid="review-error">{reviewProblem}</p> : null}
            {/* Next: the tool this take goes on to, below — or Edit & Sound for a sound. Navigation only; each tool prices its own run. */}
            <AssetNextActions entry={entry} saved={Boolean(project.productionProjectId)} onAction={(next) => (next === "edit-sound" ? onTimeline() : revealNext(next))} />
            <div className="gx-gen-enhance">
              {entry.media === "audio" ? null : <>
                <button type="button" className="gx-hbtn" onClick={() => toTimeline(entry)} data-testid="edit-to-timeline">Add to the cut</button>
                <button type="button" className="gx-hbtn" onClick={() => { sendToRig({ projectId: project.id, asset: entryAsset(entry) }); shell.goSuite("studio", "rig"); }} data-testid="edit-to-rig">Build a rig from this take</button>
              </>}
              {/* A sound's Next row opens Edit & Sound already. */}
              {entry.media === "audio" ? null : <button type="button" className="gx-hbtn" onClick={onTimeline}>Open Edit & Sound ›</button>}
              <button type="button" className="gx-hbtn" onClick={() => backToGrid(entry.take.id)} data-testid="takes-back">Back to the takes</button>
            </div>
          </section>
          {entry.media === "video" || entry.media === "audio" ? (
            /* Paid (xAI): priced first, then run at exactly that price — TranscribePanel's own approval. */
            <TranscribePanel key={entry.take.id} scope={scope} name={entry.take.name} projectId={project.productionProjectId}
              source={entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId }} />
          ) : null}
          {entry.media === "audio" ? null : entry.media === "video" ? (
            <div data-section="video"><SeedanceEditHost scope={scope} project={project} initialSource={sourceKey} onBack={() => liveShell().selectAsset(null, { reason: "close", ifCurrent: entry.take.id })} /></div>
          ) : (
            <section className="gx-gen-card gx-workflow" aria-label="Re-edit the image" data-testid="edit-image" data-section="image">
              <div className="gx-gen-row">
                <span className="gx-eyebrow" data-functional-label="">Re-edit · this workspace’s credits</span>
                <h2 className="gx-workflow-title">Change something in this still</h2>
                <p className="gx-hint">The take is the reference; only what you ask for changes. The result is a new take — the original stays.</p>
              </div>
              <PromptAttach scope={scope} projectId={projectId} onAttach={attachToEdit} testId="edit-attach"><textarea className="gx-textarea pd-small" aria-label="What should change" maxLength={EDIT_LIMIT} value={instruction} placeholder="Make it night, add rain on the glass, turn her head towards camera…" onChange={(e) => setInstruction(e.target.value)} data-testid="edit-instruction" />{extras.length ? <div className="pa-chips" data-testid="edit-extras">{extras.map((x) => <span key={x.id} className="pa-chip" {...previewAttrs({ url: "genId" in x.ref ? `/api/media/${x.ref.genId}` : `/api/uploads/${x.ref.uploadId}`, kind: "image", name: x.name })}><span className="pa-chip-name">{x.name}</span><button type="button" aria-label={`Remove ${x.name}`} onClick={() => { setExtras((prev) => prev.filter((y) => y.id !== x.id)); }}>×</button></span>)}</div> : null}</PromptAttach>
              <div className="pd-row-head">
                <span className="gx-hint">Engine</span>
                <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Re-edit engine">
                  {BOARD_MODELS.map((m) => <button key={m.id} type="button" role="radio" className="gx-seg-btn" aria-checked={model === m.id} onClick={() => setModel(m.id)}><span>{m.label}</span></button>)}
                </div>
              </div>
              <div className="gx-gen-enhance">
                <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(blocked) || Boolean(pending) || shown?.credits == null} onClick={() => void render()} data-testid="edit-render">
                  {busy || (pending ? "Rendering…" : shown?.credits != null ? `Re-edit · ${shown.credits.toLocaleString()} credits` : blocked ? "Re-edit" : shown?.error ? "Price unavailable" : "Pricing…")}
                </button>
                {shown?.error ? <button type="button" className="gx-hbtn" onClick={() => pricing.tryAgain("edit")}>Try again</button> : null}
                {blocked ? <span className="gx-reason" data-testid="edit-blocked">{blocked}</span> : null}
              </div>
              {pending && checking ? <p className="gx-reason" role="status" data-testid="edit-checking">{checking}</p> : null}
              {made && made.from === entry.take.id ? (
                <div className="pd-sketch" data-testid="edit-result">
                  <LazyMedia url={`/api/media/${made.genId}`} kind="image" alt="The re-edit" className="gx-lazy" />
                  <span className="gx-hint">The re-edit is a new take in the library.</span>
                </div>
              ) : null}
              {error || shown?.error ? <p className="gx-gen-error" role="alert">{error || shown?.error}</p> : null}
            </section>
          )}
        </>
      ) : chosen && !readFailed ? (
        /* Handed a take that cannot open (it did not render, waits, or its copy has not landed): what it is doing, and what happens next. */
        <div className="pd-row-head" data-section="edit-panel" role="status" data-testid="edit-waiting">
          <span className="gx-hint">{notOpenWords(chosen)}</span>
        </div>
      ) : picked && !chosen && !readFailed ? (
        <div className="pd-row-head" data-section="edit-panel" role="status" data-testid="edit-finding">
          <span className="gx-eyebrow" data-functional-label="">{finding ? "Finding the take…" : "That take is not in this project"}</span>
          {finding ? null : <button type="button" className="gx-hbtn" onClick={() => liveShell().selectAsset(null, { reason: "repair", ifCurrent: picked })} data-testid="takes-show-all">Show every take</button>}
        </div>
      ) : null}

      <section className="gx-gen-card pd-desk" aria-label="Takes" data-testid="edit-takes" data-section="takes">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Takes</span>
          <span className="gx-spacer" />
          <span className="gx-hint" data-testid="takes-count">{hint}</span>
        </div>
        {failed ? null : (
          <div className="pd-desk-filters" data-testid="takes-filters">
            <div className="gx-chips" role="group" aria-label="Review status" data-section="review">
              {DESK_FILTERS.map((f) => {
                const n = countLabel(counts[f.id], more);
                return (
                  <button key={f.id} type="button" className="gx-chip pd-desk-chip" data-status={f.id} {...(f.id === "all" ? { "data-kind": "All" } : { style: { "--dot": STATUS_DOT[f.id] } as React.CSSProperties })}
                    aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} data-testid="takes-filter">
                    {f.label}{n && !view.skeletons ? <span className="pd-desk-n">{n}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="pd-desk-find">
              <input type="search" className="gx-field pd-desk-search" aria-label="Search takes" placeholder="Search names, prompts, shots" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="takes-search" />
              <div className="gx-chips" role="group" aria-label="Kind">
                {DESK_KINDS.map((k) => (
                  <button key={k.id} type="button" className="gx-chip pd-desk-chip" data-kind={k.label} style={{ "--kind": KIND_CHIP_DOT[k.id] } as React.CSSProperties}
                    aria-pressed={kind === k.id} onClick={() => setKind(kind === k.id ? null : k.id)} data-testid="takes-kind">{k.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}
        {rows.length ? (
          <VirtualItems
            className="pd-take-grid pd-desk-grid" attrs={{ role: "radiogroup", "aria-label": "Takes", "data-testid": "takes-grid", "data-preview-gallery": "takes" }}
            items={rows} getKey={(item) => item.key} layout={{ minColumnWidth: 150 }} gap={10} estimateRowHeight={150} estimateWholeRow={28} scroll="ancestor"
            wholeRow={isHeading} runOf={runOf} revealKey={reveal?.key ?? null} revealNonce={reveal?.n} revealAlign="center"
            renderItem={(item) => item.type === "take" ? (
              <TakeTile entry={item.entry} variant="take" checked={entry?.take.id === item.entry.take.id} rowStart={item.first} onOpen={() => open(item.entry)} onRefresh={library.refresh} />
            ) : (
              <div className={item.type === "shot" ? "pd-desk-head" : "pd-desk-head pd-desk-head--strip"} role="heading" aria-level={item.type === "shot" ? 3 : 4} data-testid={item.type === "shot" ? "takes-shot" : "takes-strip"}>
                <span className="pd-desk-head-name">{item.label}</span>
                {item.type === "shot" ? <span className="gx-hint">{item.count.toLocaleString("en-US")}</span> : null}
              </div>
            )}
            after={failed ? null : <LibraryMore library={library} testId="takes-more" auto countWord="loaded" />}
          />
        ) : view.skeletons ? <div className="pd-take-grid"><TakeSkeletons count={4} variant="take" /></div>
          : failed ? null
          : (
            <>
              {items.length && narrowed ? (
                <div className="pd-desk-empty" role="status" data-testid="takes-empty">
                  <p className="gx-empty">{deskEmpty(desk, items.length, more)}</p>
                  <button type="button" className="gx-hbtn" onClick={clear} data-testid="takes-clear">Show every take</button>
                </div>
              ) : <p className="gx-empty" data-testid="takes-empty">Nothing generated yet. Frames from Storyboards, builds from Cast and shots from the Rig all land here.</p>}
              <LibraryMore library={library} testId="takes-more" auto countWord="loaded" />
            </>
          )}
      </section>
    </div>
  );
}
