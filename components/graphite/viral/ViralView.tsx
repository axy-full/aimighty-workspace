"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { captureVideoFrame, type VideoFrameEdge } from "@/lib/videoFrameCapture";
import { uploadFilesToProject, useProjectLibrary } from "@/lib/workspace/library";
import LazyMedia from "@/components/LazyMedia";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import { useOpenTake } from "@/lib/shell/use-open-take";
import { useKeyTake } from "@/lib/shell/use-key-take";
import { useReferenceInbox } from "@/lib/shell/reference-inbox";
import {
  INITIAL_VIRAL, PROMPT_MAX, REFERENCE_MAX, SOURCE_SECONDS, VARIANT_NAME, VIRAL_COPY, VIRAL_PAGES, VIRAL_RESOLUTIONS,
  addMedia, canCancel, downloadHref, estimateReason, genjutsuInput, mirrorSeek, moveReference, moveReferenceTo,
  takeDone, takeInFlight, takeRecipe, takeWords, viralBlock, viralMedia, viralRequest, viralTakes,
  type MirrorMark, type ViralMedia, type ViralPage, type ViralState, type ViralTake,
} from "@/lib/shell/viral";
import { ago } from "@/lib/workspace/activity";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useClock } from "../ResumedJobs";
import { Glyph } from "../icons";
import { Price, usePriceTitle } from "../Price";
import { priceWords, upTo } from "@/lib/shell/price-words";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3), on Particl's API key for every
 * workspace and every member. Motion Transfer and Object Swap are Make's quick
 * tools (design/particl-graphite/README.md § 3.2, `make=motion|swap`): one
 * composer in the Make panel — exactly one source video (4–30 s, index 0) and
 * 1–8 ordered reference images, a resolution, an optional direction — priced
 * by the one workspace-credit path (lib/shell/use-key-take.ts): the button
 * wears the live estimate ("about N cr"), a press prices again and sends once
 * at that figure, and a missing estimate blocks it with the reason. The
 * source's start and end frames can be saved to the project and used as
 * references, and the original downloaded. Client media stays in Particl's
 * storage.
 *
 * Recent under a tool is that variant's takes in this project; History (still
 * a page of its own) is every transform take in the project (Queued ·
 * Rendering · Held · Failed · Done, in words), with Recreate · Compare · Send
 * to Edit · Download, and Cancel while a take still waits its turn at the
 * provider. Both are read from the project's Library alone, which also keeps
 * the runs made earlier on the owner's connected account (read-only; Recreate
 * brings them to the key). Nothing here reads the account.
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const PRESET_KEY = "particl-viral-preset";
/* Recreate into a tool that is already open: the letter is in session storage, this says it is there. */
const PRESET_EVENT = "particl-viral-preset";
const when = (at: number, now: number) => { const t = ago(at, now); return t === "just now" ? t : `${t} ago`; };
const refs = (n: number) => `${n} ${n === 1 ? "ref" : "refs"}`;
/* The panel's own words for the two tools (design/particl-graphite/Particl Suites.dc.html › Make). */
const TOOL = {
  motion: { name: "Motion transfer", refs: `References · 1 to ${REFERENCE_MAX}`, source: "The motion to recast" },
  swap: { name: "Object swap", refs: "The replacement", source: "The clip with the element to replace" },
} as const;
export const toolName = (page: ViralPage) => TOOL[page].name;

/**
 * The Social board's source video, handed to a quick tool (stream 11): the same letter Recreate leaves (session storage, then
 * a window event for a tool already open), and Make opens on the tool. It prices again in Make before anything runs.
 */
export function sendViralSource(page: ViralPage, source: ViralMedia, openMake: (tab: ViralPage) => void) {
  try { sessionStorage.setItem(PRESET_KEY, JSON.stringify({ ...INITIAL_VIRAL, source, page })); } catch { /* the tool starts empty */ }
  openMake(page);
  window.dispatchEvent(new Event(PRESET_EVENT));
}

/** Today's History view, for the Social board's History drawer (stream 11): every Motion transfer and Object swap take in the project. */
export function ViralHistory({ scope, project, items }: { scope: string; project: Project | null; items: LibraryEntry[] }) {
  return <HistoryView scope={scope} project={project} items={items} />;
}

/** Viral's page: History. Motion Transfer and Object Swap are ViralTool, in the Make panel. */
export function ViralView({ scope, project, items }: { scope: string; project: Project | null; items: LibraryEntry[] }) {
  return <HistoryView scope={scope} project={project} items={items} />;
}

function findMedia(items: LibraryEntry[], id: string): ViralMedia | null {
  const entry = items.find((e) => e.take.id === id);
  return entry ? viralMedia(entry) : null;
}
/** A finished take opens in Takes, where a take is re-edited — that take (lib/shell/use-open-take). */
function useSendToTakes(scope: string, project: Project | null) {
  const { openTake, opening } = useOpenTake(scope, project);
  const sendTake = (take: Pick<ViralTake, "id" | "createdAt">) => openTake(take.id, take.id, take.createdAt);
  return { sendTake, opening };
}

/** The inputs Recreate left for this tool, taken once; null when there are none or they are the other tool's. */
function takePreset(page: ViralPage): ViralState | null {
  try {
    const raw = sessionStorage.getItem(PRESET_KEY);
    if (!raw) return null;
    const { page: wanted, ...state } = JSON.parse(raw) as Partial<ViralState> & { page?: string };
    if (wanted && wanted !== page) return null;
    sessionStorage.removeItem(PRESET_KEY);
    return { ...INITIAL_VIRAL, ...state };
  } catch { return null; }
}

/**
 * Hand a take's recipe to the tool of its variant, which prices it again
 * before anything runs. What this route cannot carry (a run made earlier on
 * the account with more than eight stills, or a size it does not offer) is
 * said, never silently changed.
 */
function useRecreate(items: LibraryEntry[]) {
  const shell = useShell();
  const ws = useWorkspace();
  return (take: ViralTake) => {
    const recipe = takeRecipe(take);
    if ("error" in recipe) { ws.toast(recipe.error); return; }
    const source = findMedia(items, recipe.source);
    const references = recipe.references.map((id) => findMedia(items, id)).filter((m): m is ViralMedia => Boolean(m));
    if (!source || references.length !== recipe.references.length) { ws.toast("Some of this take’s originals are no longer in the project, so it cannot be recreated exactly."); return; }
    const kept = references.slice(0, REFERENCE_MAX);
    const resolution = VIRAL_RESOLUTIONS.includes(recipe.resolution) ? recipe.resolution : INITIAL_VIRAL.resolution;
    const page: ViralPage = recipe.variant === "motion-transfer" ? "motion" : "swap";
    const state: ViralState = { resolution, prompt: recipe.prompt.slice(0, PROMPT_MAX), source, references: kept };
    try { sessionStorage.setItem(PRESET_KEY, JSON.stringify({ ...state, page })); } catch { /* the tool starts empty */ }
    shell.openMake(page);
    window.dispatchEvent(new Event(PRESET_EVENT));
    ws.toast([kept.length < references.length ? `Loaded the first ${REFERENCE_MAX} of ${references.length} references; this route takes up to ${REFERENCE_MAX}.` : "Same inputs loaded.",
      resolution !== recipe.resolution ? `${recipe.resolution} is not offered here, so it is set to ${resolution}.` : "", "It is priced again before it runs."].filter(Boolean).join(" "));
  };
}

/**
 * Make › Motion transfer / Object swap (README § 3.2, the master's quick-tool mode): the source video card, the
 * direction with its resolution, the references, the line with today's live estimate, and the button at that
 * figure. Everything the drawn panel has no place for yet — the source's frames and download, the references'
 * order, the run's status and Cancel, Recent and History — follows below, as the Viral page had it.
 */
export function ViralTool({ scope, page, project, items }: { scope: string; page: ViralPage; project: Project | null; items: LibraryEntry[] }) {
  const shell = useShell();
  const session = useSession();
  const copy = VIRAL_COPY[page];
  const tool = TOOL[page];
  const variant = VIRAL_PAGES[page];
  const sendToTakes = useSendToTakes(scope, project);
  const take = useKeyTake(scope, project?.id ?? null, `viral:${variant}`);
  /* Recreate hands over the finished take's own inputs, already resolved against the Library. */
  const [s, set] = useState<ViralState>(() => takePreset(page) ?? INITIAL_VIRAL);
  useEffect(() => {
    const arrived = () => { const next = takePreset(page); if (next) set(next); };
    window.addEventListener(PRESET_EVENT, arrived);
    return () => window.removeEventListener(PRESET_EVENT, arrived);
  }, [page]);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  const production = project?.productionProjectId ?? null;
  const blocked = viralBlock(s, { hasProject: Boolean(project), saved: Boolean(production) });
  const input = useMemo(() => (blocked ? null : genjutsuInput(page, s)), [blocked, page, s]);
  const request = useMemo(() => (input && project && production ? viralRequest(input, { id: project.id, productionProjectId: production }) : null), [input, project, production]);
  const key = JSON.stringify(request);
  /* The page's Atomik plan prices and sends this very body through its own gate (lib/workspace/plans.ts › motions, swaps). */
  const planBodies = useMemo(() => (request?.endpoint === "/api/generate" && request.input ? [{ name: VARIANT_NAME[VIRAL_PAGES[page]], body: generationRequestBody(request.input) }] : undefined), [request, page]);
  usePlanRequest(page, planBodies);
  /* The estimate: read for exactly this request, again when it changes or ages; never while a press is being sent or followed. */
  const quote = take.quote, estimateKey = take.estimate?.key, estimateExpires = take.estimate?.expiresAt ?? 0, runPhase = take.run.phase;
  const busy = runPhase === "submitting" || runPhase === "running";
  useEffect(() => {
    if (!request || busy) return;
    if (estimateKey === key && estimateExpires > now) return;
    const timer = setTimeout(() => void quote(request, key), 600);
    return () => clearTimeout(timer);
  }, [request, key, quote, estimateKey, estimateExpires, now, busy]);
  const reason = blocked ?? estimateReason(take.estimate, key, now);
  const credits = !reason && take.estimate?.key === key ? take.estimate.credits : null;

  /* Several at once apply in order, each against the state the last one left. */
  const place = useCallback((medias: ViralMedia[], missing = 0) => {
    const notes: string[] = [];
    set((prev) => { let st = prev; notes.length = 0; for (const m of medias) { const r = addMedia(st, m); st = r.state; if (r.note) notes.push(r.note); } return st; });
    setNote([...(missing ? ["That asset is not in this project's Library."] : []), ...notes].join(" ") || null);
  }, []);
  /* The Library's `+` and a right-click's Use as reference land here while the tool is open: a video is the source, a picture a reference. */
  const letter = useCallback((sent: { id: string }) => { const m = findMedia(items, sent.id); place(m ? [m] : [], m ? 0 : 1); }, [items, place]);
  useReferenceInbox(letter);
  /* The prompt takes media too: a video becomes the source, pictures the references. */
  const attachToViral = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const fit = media.filter((m) => m.kind === "video" || m.kind === "image");
    place(fit.map((m): ViralMedia => ({ id: m.key, sourceId: m.id, origin: m.origin, kind: m.kind as "video" | "image", name: m.name, url: m.url, seconds: m.seconds })));
    return keptNote([...unreadable, ...media.filter((m) => !fit.includes(m)).map((m) => m.name)], "this takes one source video and reference pictures.");
  };
  /* A tile from anywhere, or files from the device: uploaded into the project and placed at once. */
  const dropped = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const { ids, files } = readDrop(e.dataTransfer, project?.assets);
    const found = ids.map((id) => findMedia(items, id));
    place(found.filter((m): m is ViralMedia => Boolean(m)), found.filter((m) => !m).length);
    if (!files.length) return;
    if (!project) { setNote("Open a project first; dropped files are kept in its Library."); return; }
    setNote(`Uploading ${files.length === 1 ? files[0].name : `${files.length} files`}…`);
    void uploadFilesToProject(scope, project.id, files).then(({ uploads, notes }) => {
      const medias = uploads.flatMap((u): ViralMedia[] => (u.kind === "video" || u.kind === "image" ? [{ id: `upload:${u.id}`, sourceId: u.id, origin: "upload", kind: u.kind, name: u.filename, url: u.url, seconds: u.durationS ?? null }] : []));
      place(medias);
      if (notes.length || medias.length < uploads.length) setNote([...notes, ...(medias.length < uploads.length ? ["Only videos and pictures go in this well; the rest is kept in the Library."] : [])].join(" "));
    }).catch((error: unknown) => setNote(error instanceof Error ? error.message : "The files could not be uploaded."));
  };
  const drop = {
    onDragOver: (e: React.DragEvent) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: dropped,
  };
  const run = take.run;
  /* The button wears the live estimate as "up to N cr" (the price shown before anything is paid), and waits for it: with no figure it is disabled. */
  const figure = upTo(credits);
  const figureTitle = usePriceTitle(figure) ?? undefined;
  const priced = run.phase !== "submitting" && run.phase !== "running" && figure != null;
  const label = run.phase === "submitting" ? "Submitting…" : run.phase === "running" ? "Rendering…" : null;
  const buttonName = label ?? (priced ? `${copy.verb} · ${priceWords(figure)}` : copy.verb);
  const estimateFailed = Boolean(!blocked && take.estimate?.key === key && take.estimate.error);
  const running = run.phase === "running" ? run : null;
  const runningTake = running ? viralTakes(items, variant).find((t) => t.id === running.jobId) ?? null : null;
  const seconds = s.source?.seconds != null ? `${Math.round(s.source.seconds)} s` : null;
  const library = () => shell.openLibrary("assets");

  const swap = page === "swap";
  const dragging = useRef<string | null>(null);
  const [frames, setFrames] = useState<{ start?: ViralMedia; end?: ViralMedia }>({});
  const reorder = (id: string, to: number) => set((prev) => moveReferenceTo(prev, id, to));

  return (
    <section className="gx-gen-card gx-make-compose vr-tool" aria-label={tool.name} data-testid="viral-view" data-page={page}>
      {/* Running, on the panel: where it stands in words, and Cancel only while it still waits its turn at the provider. */}
      {running ? (
        <div className="vr-running" role="status" data-testid="viral-running">
          <span className="gx-eyebrow" data-functional-label="">Running</span>
          <span className="vr-bar" data-indeterminate="" aria-hidden="true" />
          <span className="gx-gen-note">{running.held ? "Held · it starts when credits arrive." : runningTake ? takeWords(runningTake).label : "Queued"} · {priceWords(upTo(running.credits))}</span>
          {runningTake && canCancel(runningTake, session) ? (
            <span className="vr-done-actions">
              <button type="button" className="gx-hbtn" disabled={take.cancelling === running.jobId} onClick={() => void take.cancel(running.jobId)} data-testid="viral-cancel">{take.cancelling === running.jobId ? "Cancelling…" : "Cancel"}</button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="gx-make-label"><span className="gx-eyebrow" data-functional-label="">Source video</span><span className="gx-hint">one · {SOURCE_SECONDS.min}–{SOURCE_SECONDS.max} s</span></div>
      <div className="vr-src" data-over={over} {...drop} data-testid="viral-source-card">
        <div className="vr-src-media">
          {s.source?.url ? <LazyMedia url={s.source.url} kind="video" alt="" name={s.source.name} className="gx-lazy" /> : null}
          <span className="gx-badge vr-src-badge">{["SOURCE", seconds].filter(Boolean).join(" · ")}</span>
          {s.source ? <button type="button" className="gx-ref-x vr-src-x" aria-label={`Remove ${s.source.name}`} onClick={() => set({ ...s, source: null })}>×</button> : null}
        </div>
        <div className="vr-src-foot">
          <div className="vr-src-text">
            {s.source ? <span className="vr-src-name" data-testid="viral-source">{s.source.name}{seconds ? ` · ${seconds}` : ""}</span> : <span className="vr-src-name">Choose a video</span>}
            <span className="vr-src-line">{tool.source}</span>
          </div>
          <button type="button" className="gx-hbtn" onClick={library}>Change</button>
        </div>
      </div>

      <div className="vr-words">
        <div className="gx-make-label"><span className="gx-eyebrow" data-functional-label="">{swap ? "Replace" : "Direction"}</span><span className="gx-hint">{swap ? "one element" : "optional"}</span></div>
        <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToViral} testId="viral-attach"><textarea className="gx-textarea gx-make-words" aria-label={copy.promptLabel} rows={3} maxLength={PROMPT_MAX} placeholder={copy.promptPlaceholder} value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="viral-prompt" /></PromptAttach>
        <div className="gx-seg gx-seg--sm vr-res" role="radiogroup" aria-label="Resolution">
          {VIRAL_RESOLUTIONS.map((r) => <button key={r} type="button" role="radio" className="gx-seg-btn" aria-checked={s.resolution === r} onClick={() => set({ ...s, resolution: r })}><span>{r}</span></button>)}
        </div>
      </div>

      <div className="vr-refs" data-over={over} {...drop} data-testid="viral-well">
        <div className="gx-make-label"><span className="gx-eyebrow" data-functional-label="">{swap ? "With" : tool.refs}</span><span className="gx-hint">{s.references.length} of {REFERENCE_MAX}{s.references.length > 1 ? " · drag to reorder" : ""}</span></div>
        <div className="vr-ref-grid">
          {s.references.map((r, i) => (
            <div className="vr-ref-tile" key={r.id} data-testid="viral-reference" draggable data-index={i + 1}
              onDragStart={(e) => { dragging.current = r.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
              onDragEnd={() => { dragging.current = null; }}
              onDragOver={(e) => { if (dragging.current) { e.preventDefault(); e.stopPropagation(); } }}
              onDrop={(e) => { if (!dragging.current) return; e.preventDefault(); e.stopPropagation(); reorder(dragging.current, i); dragging.current = null; }}>
              {r.url ? <LazyMedia url={r.url} kind="image" alt="" name={r.name} className="gx-lazy" /> : null}
              <span className="vr-ref-num" aria-hidden="true">{i + 1}</span>
              <span className="vr-ref-name">{r.name}</span>
              <button type="button" className="vr-ref-x" aria-label={`Remove ${r.name}`} onClick={() => set({ ...s, references: s.references.filter((x) => x.id !== r.id) })}>×</button>
            </div>
          ))}
          {s.references.length < REFERENCE_MAX ? <button type="button" className="vr-ref-add" onClick={library}><span aria-hidden="true">+</span>Add</button> : null}
        </div>
        {note ? <p className="gx-gen-note" role="status" data-testid="viral-note">{note}</p> : null}
      </div>

      {s.source && project ? <SourceTools scope={scope} projectId={project.id} source={s.source} full={s.references.length >= REFERENCE_MAX} frames={frames}
        onFrame={(edge, frame) => { setFrames((now) => ({ ...now, [edge]: frame })); place([frame]); }} onNote={setNote} /> : null}

      <div className="gx-make-engine vr-engine" data-testid="viral-engine">
        <Glyph name="spark" size={16} className="gx-glyph" />
        <span className="gx-make-engine-line">
          <span className="gx-model-name">{tool.name}</span>
          <span className="gx-make-engine-part">{s.resolution}</span>
          {seconds ? <span className="gx-make-engine-part">{seconds}</span> : null}
          {credits != null ? <span className="gx-make-engine-part gx-mono" data-testid="make-engine-price" title={figureTitle}><Price value={figure} /></span> : null}
        </span>
      </div>

      {reason ? (
        <div className="vr-reason-row">
          <p className="gx-reason" id="vr-reason" data-testid="viral-reason">{reason}</p>
          {estimateFailed && request ? <button type="button" className="gx-hbtn" onClick={() => void take.quote(request, key)} data-testid="viral-reason-retry">Try again</button> : null}
        </div>
      ) : null}
      {run.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="viral-error">{run.error}</p> : null}
      {take.note ? <p className="gx-gen-note" role="status" data-testid="viral-take-note">{take.note}</p> : null}
      <div className="gx-gen-cta gx-make-go">
        <span className="gx-make-dest" data-testid="make-dest">{project ? `To ${project.name} · Library` : null}</span>
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(reason) || busy || credits == null} aria-describedby={reason ? "vr-reason" : undefined} aria-label={buttonName} title={priced ? figureTitle : undefined} data-priced={priced ? "" : undefined} data-spend={priced ? "priced" : "unpriced"}
          onClick={() => { if (request) void take.submit(request, key, credits); }} data-testid="viral-generate">
          {label ?? (<><span className="gx-go-act">{copy.verb}</span>{priced ? <span className="gx-go-price"><span className="gx-go-sep">{" · "}</span><Price value={figure} /></span> : null}</>)}
        </button>
      </div>

      {/* Below: what the drawn panel has no place for yet, as the Viral page had it. */}
      <div className="gx-make-more" data-testid="make-more">
        {credits != null ? <p className="gx-gen-foot" data-testid="viral-foot">An estimate from the live price · filed to this project’s takes</p> : null}
        {run.phase === "done" ? (
          <div className="vr-done" role="status" data-testid="viral-done">
            <span className="gx-gen-note">Rendered.</span>
            <span className="vr-done-actions">
              <button type="button" className="gx-hbtn" disabled={sendToTakes.opening === run.jobId} onClick={() => { if (run.phase === "done") void sendToTakes.sendTake({ id: run.jobId, createdAt: run.generation.createdAt }); }} data-testid="viral-open-takes">{sendToTakes.opening === run.jobId ? "Opening…" : "Open in Takes"}</button>
              <button type="button" className="gx-hbtn" onClick={() => { take.reset(); shell.goSuite("viral", "history", { closeMake: true }); }} data-testid="viral-open-history">Open History</button>
            </span>
          </div>
        ) : null}
        {s.references.length > 1 ? (
          <div className="gx-gen-row vr-order" data-testid="viral-order">
            <span className="cw-dim">{s.references.length} of {REFERENCE_MAX} reference images · order is the order sent</span>
            {s.references.map((r, i) => (
              <span className="gx-ref" key={r.id}>
                <span className="bz-role">image · {i + 1}</span>
                <span className="gx-ref-name">{r.name}</span>
                <button type="button" className="gx-ref-x" aria-label={`Move ${r.name} earlier`} disabled={i === 0} onClick={() => set(moveReference(s, r.id, -1))}>↑</button>
                <button type="button" className="gx-ref-x" aria-label={`Move ${r.name} later`} disabled={i === s.references.length - 1} onClick={() => set(moveReference(s, r.id, 1))}>↓</button>
              </span>
            ))}
          </div>
        ) : null}
        <Recent scope={scope} page={page} project={project} items={items} take={take} send={sendToTakes} />
      </div>
    </section>
  );
}

/**
 * Start and end frames (optional): the source's first or last frame saved to the project as a full-size still and placed as the
 * next reference, and the original downloaded. The frame is read from Particl's own copy in the browser; no provider is asked and
 * nothing is charged. A saved frame shows here as its picture.
 */
function SourceTools({ scope, projectId, source, full, frames, onFrame, onNote }: { scope: string; projectId: string; source: ViralMedia; full: boolean; frames: { start?: ViralMedia; end?: ViralMedia }; onFrame: (edge: VideoFrameEdge, frame: ViralMedia) => void; onNote: (note: string | null) => void }) {
  const [busy, setBusy] = useState<VideoFrameEdge | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const grab = async (edge: VideoFrameEdge) => {
    if (busy) return;
    setBusy(edge);
    onNote(null);
    try {
      const url = `/api/${source.origin === "upload" ? "uploads" : "media"}/${source.sourceId}`;
      const frame = await captureVideoFrame({ id: source.sourceId, origin: source.origin, url, name: source.name }, edge, scope);
      const file = new File([frame.blob], frame.filename, { type: "image/png", lastModified: 0 });
      const { uploads, notes } = await uploadFilesToProject(scope, projectId, [file]);
      if (!alive.current) return;
      const saved = uploads.find((u) => u.kind === "image");
      if (!saved) { onNote(notes[0] ?? "The frame could not be saved."); return; }
      const still: ViralMedia = { id: `upload:${saved.id}`, sourceId: saved.id, origin: "upload", kind: "image", name: saved.filename, url: saved.url, seconds: null };
      if (full) onNote(`${edge === "start" ? "Start" : "End"} frame saved to this project · ${frame.width} × ${frame.height} PNG. The references are full.`);
      else { onFrame(edge, still); onNote(`${edge === "start" ? "Start" : "End"} frame saved to this project and added as a reference · ${frame.width} × ${frame.height} PNG.`); }
    } catch (error) {
      if (alive.current) onNote(error instanceof Error ? error.message : "The frame could not be saved.");
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  return (
    <div className="vr-frames" data-testid="viral-source-tools">
      <div className="gx-make-label"><span className="gx-eyebrow" data-functional-label="">Start and end frames</span><span className="gx-hint">optional</span></div>
      <div className="vr-frame-row">
        {(["start", "end"] as const).map((edge) => (
          <button key={edge} type="button" className="vr-frame" disabled={Boolean(busy)} data-set={frames[edge] ? "" : undefined} onClick={() => void grab(edge)} data-testid={`viral-frame-${edge}`}
            aria-label={busy === edge ? "Saving frame…" : `${edge === "start" ? "Start" : "End"} frame${frames[edge] ? " (saved)" : ""}`}>
            {frames[edge]?.url ? <LazyMedia url={frames[edge]!.url!} kind="image" alt="" name={frames[edge]!.name} className="gx-lazy" /> : <span className="vr-frame-add" aria-hidden="true">+</span>}
            <span className="vr-frame-name">{busy === edge ? "Saving…" : edge === "start" ? "Start" : "End"}</span>
          </button>
        ))}
        <a className="gx-hbtn vr-download" href={downloadHref(source.origin, source.sourceId)} download data-testid="viral-source-download">Download source</a>
      </div>
    </div>
  );
}

type Send = ReturnType<typeof useSendToTakes>;
type Take = ReturnType<typeof useKeyTake>;
/** This variant's last four takes in the project, each in words, each finished one a way into Takes. */
function Recent({ scope, page, project, items, take, send }: { scope: string; page: ViralPage; project: Project | null; items: LibraryEntry[]; take: Take; send: Send }) {
  const shell = useShell();
  const session = useSession();
  const now = useClock();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const mine = viralTakes(items, VIRAL_PAGES[page]);
  const status = library.state.status;
  return (
    <section className="gx-gen-results" aria-label="Recent" data-testid="viral-recent" aria-busy={status === "loading" || status === "idle"}>
      <div className="gx-gen-results-head"><span className="gx-panel-title">Recent</span><button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "history", { closeMake: true })}>Open History</button></div>
      {!project ? <p className="cw-dim">Open a project to see its takes.</p>
        : (status === "loading" || status === "idle") && !mine.length ? <><span className="vr-job vr-skel" aria-hidden="true" /><span className="vr-job vr-skel" aria-hidden="true" /></>
        : status === "error" && !mine.length ? <LibraryError message={library.state.error} onRetry={() => void library.refresh()} />
        : mine.length ? mine.slice(0, 4).map((t) => <TakeRow key={t.id} take={t} now={now} cancel={canCancel(t, session) ? take : null} send={send} />)
        : <p className="cw-dim" data-testid="viral-recent-empty">No {VIRAL_COPY[page].title} takes yet.</p>}
    </section>
  );
}

function LibraryError({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="vr-list-error" role="alert" data-testid="viral-library-error">
      <span className="gx-gen-error">{message ?? "The project's takes could not be read."}</span>
      <button type="button" className="gx-hbtn" onClick={onRetry}>Try again</button>
    </div>
  );
}

/** A take's meta: resolution, references, the settled credits, and when. */
const takeMeta = (t: ViralTake, now: number) => [t.resolution, refs(t.refs), t.credits != null && t.credits > 0 ? cr(t.credits) : null, when(t.createdAt, now)].filter(Boolean).join(" · ");
/** The direction a take was given, else what kind of take it was. */
const takeBrief = (t: ViralTake) => t.prompt.trim() || VARIANT_NAME[t.variant];

function TakeRow({ take, now, cancel, send }: { take: ViralTake; now: number; cancel: Take | null; send: Send }) {
  const words = takeWords(take);
  const done = takeDone(take);
  return (
    <div className="vr-job" data-status={take.status} data-testid="viral-take">
      <span className="vr-dot" data-tone={words.tone} aria-hidden="true" />
      <span className="vr-job-name" title={take.prompt || undefined}>{takeBrief(take)}</span>
      <span className="vr-status" data-tone={words.tone} data-testid="viral-take-status">{words.label}</span>
      <span className="cw-dim vr-job-meta">{takeMeta(take, now)}</span>
      {/* A failed take: why, what the provider did with the charge, and what to do (lib/errors.ts failureLine). */}
      {take.status === "failed" && take.failureLine ? <span className="vr-job-note vr-job-fail" data-testid="viral-take-failure">{take.failureLine}</span>
        : take.reason && !done ? <span className="cw-dim vr-job-note" data-testid="viral-take-note">{take.reason}</span> : null}
      {done ? (
        <button type="button" className="gx-hbtn vr-job-act" disabled={!take.url || send.opening === take.id} onClick={() => void send.sendTake(take)} data-testid="viral-take-open">{send.opening === take.id ? "Opening…" : "Open in Takes"}</button>
      ) : cancel ? (
        <button type="button" className="gx-hbtn vr-job-act" disabled={cancel.cancelling === take.id} onClick={() => void cancel.cancel(take.id)} data-testid="viral-take-cancel">{cancel.cancelling === take.id ? "Cancelling…" : "Cancel"}</button>
      ) : null}
    </div>
  );
}

/* ── History ─────────────────────────────────────────────────────────── */
function HistoryView({ scope, project, items }: { scope: string; project: Project | null; items: LibraryEntry[] }) {
  const shell = useShell();
  const session = useSession();
  const now = useClock();
  const library = useProjectLibrary(scope, project?.id ?? null);
  const sendToTakes = useSendToTakes(scope, project);
  const recreate = useRecreate(items);
  const take = useKeyTake(scope, project?.id ?? null, "viral:history");
  const [compare, setCompare] = useState<{ title: string; source: string | null; result: string | null } | null>(null);
  const takes = viralTakes(items);
  const status = library.state.status;
  const sourceOf = (t: ViralTake) => { const recipe = takeRecipe(t); return "error" in recipe ? null : findMedia(items, recipe.source)?.url ?? null; };

  let body: React.ReactNode;
  if (!project) body = <p className="gx-empty" data-testid="history-no-project">Open or create a project to see its takes.</p>;
  else if ((status === "loading" || status === "idle") && !takes.length) body = (
    <div className="gx-gen-grid" aria-hidden="true" data-testid="history-loading">
      {[0, 1, 2, 3].map((i) => <div className="gx-asset" key={i}><div className="gx-asset-thumb vr-skel" /><span className="vr-skel vr-skel--line" /><span className="vr-skel vr-skel--line vr-skel--short" /></div>)}
    </div>
  );
  else if (status === "error" && !takes.length) body = <LibraryError message={library.state.error} onRetry={() => void library.refresh()} />;
  else if (!takes.length && !library.hasMore) body = (
    <div className="cw-empty vr-empty" data-testid="history-empty">
      <span>No takes in this project yet.</span>
      <span className="vr-empty-actions">
        <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "motion")}>Motion Transfer</button>
        <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "swap")}>Object Swap</button>
      </span>
    </div>
  );
  else body = (
    <>
      {status === "ready" && library.state.error ? <LibraryError message={library.state.error} onRetry={() => void library.refresh()} /> : null}
      {takes.length ? (
        <div className="gx-gen-grid" data-testid="history-takes">
          {takes.map((t) => (
            <TakeCard key={t.id} take={t} now={now} opening={sendToTakes.opening === t.id} cancel={canCancel(t, session) ? take : null}
              onRecreate={recreate} onCompare={() => setCompare({ title: VARIANT_NAME[t.variant], source: sourceOf(t), result: t.url })} onSend={(x) => void sendToTakes.sendTake(x)} />
          ))}
        </div>
      ) : <p className="cw-dim" data-testid="history-none-loaded">No transform takes among the newest in this project.</p>}
      {library.hasMore ? (
        <div className="vr-more">
          <button type="button" className="gx-hbtn" disabled={library.state.moreBusy} onClick={() => void library.more()} data-testid="history-more">{library.state.moreBusy ? "Loading…" : "Load older takes"}</button>
        </div>
      ) : null}
      {take.note ? <p className="gx-gen-note" role="status" data-testid="history-note">{take.note}</p> : null}
    </>
  );
  return (
    <div className="vr-history gx-enter" data-testid="history-view" aria-busy={status === "loading"}>
      {body}
      {compare ? <CompareSheet title={compare.title} source={compare.source} result={compare.result} onClose={() => setCompare(null)} /> : null}
    </div>
  );
}

/** One take: the result and its next steps once it lands; until then, where it stands (and Cancel while it waits its turn). */
function TakeCard({ take, now, opening, cancel, onRecreate, onCompare, onSend }: { take: ViralTake; now: number; opening: boolean; cancel: Take | null; onRecreate: (t: ViralTake) => void; onCompare: () => void; onSend: (t: ViralTake) => void }) {
  const words = takeWords(take);
  const done = takeDone(take), flying = takeInFlight(take);
  return (
    <div className="gx-asset vr-run" data-testid={done ? "history-result" : "history-take"} data-status={take.status} data-account={take.account || undefined}>
      <div className="gx-asset-thumb">
        {done && take.url ? <LazyMedia url={take.url} kind="video" alt="" className="gx-lazy" />
          : <span className="vr-veil" data-tone={done ? "idle" : words.tone} data-flying={flying}>
            <span className="vr-status" data-tone={done ? "idle" : words.tone} data-testid="history-take-status">{done ? "Preview unavailable" : words.label}</span>
            {take.reason && !done ? <span className="vr-veil-note" data-testid="history-take-note">{take.reason}</span> : null}
          </span>}
      </div>
      <span className="gx-asset-name">{VARIANT_NAME[take.variant]} · {take.resolution}</span>
      <span className="gx-asset-meta" title={take.prompt || undefined}>{[refs(take.refs), take.prompt.trim()].filter(Boolean).join(" · ")}</span>
      <span className="gx-asset-meta" title={new Date(take.createdAt).toLocaleString()}>{[take.account ? "Earlier, on the connected account" : null, take.credits != null && take.credits > 0 ? cr(take.credits) : null, when(take.createdAt, now)].filter(Boolean).join(" · ")}</span>
      {take.status === "failed" && take.failureLine ? <span className="gx-asset-fail" data-testid="history-take-failure">{take.failureLine}</span> : null}
      {done ? (
        <div className="cw-sol-actions">
          <button type="button" className="gx-hbtn" onClick={() => onRecreate(take)}>Open in Make</button>
          <button type="button" className="gx-hbtn" disabled={!take.url} onClick={onCompare}>Compare</button>
          <button type="button" className="gx-hbtn" disabled={!take.url || opening} onClick={() => onSend(take)}>{opening ? "Opening…" : "Send to Edit"}</button>
          <a className="gx-hbtn" href={downloadHref("generation", take.id)} download data-testid="history-take-download">Download</a>
        </div>
      ) : take.status === "failed" ? (
        <div className="cw-sol-actions"><button type="button" className="gx-hbtn" onClick={() => onRecreate(take)}>Open in Make</button></div>
      ) : cancel ? (
        <div className="cw-sol-actions"><button type="button" className="gx-hbtn" disabled={cancel.cancelling === take.id} onClick={() => void cancel.cancel(take.id)} data-testid="history-take-cancel">{cancel.cancelling === take.id ? "Cancelling…" : "Cancel"}</button></div>
      ) : null}
    </div>
  );
}

/** Original and result on one clock: play, pause and seek together. */
function CompareSheet({ title, source, result, onClose }: { title: string; source: string | null; result: string | null; onClose: () => void }) {
  const a = useRef<HTMLVideoElement>(null), b = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  /* A seek mirrored onto the other player fires its own `seeked`; that one is not mirrored back. */
  const mirrored = useRef<MirrorMark<HTMLVideoElement>>(null);
  const follow = (from: HTMLVideoElement, to: HTMLVideoElement | null) => { mirrorSeek(from, to, mirrored); };
  const both = (fn: (v: HTMLVideoElement) => void) => [a.current, b.current].forEach((v) => v && fn(v));
  const toggle = () => { if (playing) { both((v) => v.pause()); setPlaying(false); } else { both((v) => { void v.play().catch(() => undefined); }); setPlaying(true); } };
  return (
    <div className="gx-veil" onClick={onClose} data-testid="compare-veil">
      <div className="gx-sheet vr-compare" role="dialog" aria-modal="true" aria-label="Compare" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="gx-sheet-head"><span className="gx-panel-title">Compare · {title}</span><button type="button" className="gx-hbtn" onClick={toggle}>{playing ? "Pause" : "Play both"}</button><button type="button" className="gx-hbtn" onClick={onClose}>Close</button></div>
        <div className="vr-compare-grid">
          <figure><figcaption className="gx-eyebrow">Original</figcaption>{source ? <video ref={a} src={source} playsInline preload="metadata" onSeeked={(e) => follow(e.currentTarget, b.current)} controls /> : <p className="cw-dim">The source is no longer in this project.</p>}</figure>
          <figure><figcaption className="gx-eyebrow">Result</figcaption>{result ? <video ref={b} src={result} playsInline preload="metadata" onSeeked={(e) => follow(e.currentTarget, a.current)} controls /> : <p className="cw-dim">The result’s original is not available yet.</p>}</figure>
        </div>
      </div>
    </div>
  );
}
