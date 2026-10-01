"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { captureVideoFrame, type VideoFrameEdge } from "@/lib/videoFrameCapture";
import { uploadFilesToProject, useProjectLibrary } from "@/lib/workspace/library";
import LazyMedia from "@/components/LazyMedia";
import { useSession } from "@/lib/session";
import { useShell } from "@/lib/shell/state";
import { useOpenTake } from "@/lib/shell/use-open-take";
import { useKeyTake } from "@/lib/shell/use-key-take";
import {
  INITIAL_VIRAL, PROMPT_MAX, REFERENCE_MAX, VARIANT_NAME, VIRAL_COPY, VIRAL_PAGES, VIRAL_RESOLUTIONS,
  aboutCredits, addMedia, canCancel, downloadHref, estimateReason, genjutsuInput, mirrorSeek, moveReference,
  takeDone, takeInFlight, takeRecipe, takeWords, viralBlock, viralMedia, viralRequest, viralTakes,
  type MirrorMark, type ViralMedia, type ViralPage, type ViralState, type ViralTake,
} from "@/lib/shell/viral";
import { ago } from "@/lib/workspace/activity";
import { usePlanRequest } from "@/lib/workspace/atomik-host";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { useClock } from "@/lib/shell/use-clock";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3), on Particl's API key for every
 * workspace and every member. Motion Transfer and Object Swap share one
 * composer — exactly one source video (4–30 s, index 0) and 1–8 ordered
 * reference images, a resolution, an optional direction — priced by the one
 * workspace-credit path (lib/shell/use-key-take.ts): the button wears the
 * live estimate ("about N cr"), a press prices again and sends once at that
 * figure, and a missing estimate blocks it with the reason. The source's
 * start and end frames can be saved to the project and used as references,
 * and the original downloaded. Client media stays in Particl's storage.
 *
 * Recent beside a composer is that variant's takes in this project; History
 * is every transform take in the project (Queued · Rendering · Held · Failed
 * · Done, in words), with Recreate · Compare · Send to Edit · Download, and
 * Cancel while a take still waits its turn at the provider. Both are read
 * from the project's Library alone, which also keeps the runs made earlier on
 * the owner's connected account (read-only; Recreate brings them to the key).
 * Nothing here reads the account.
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const PRESET_KEY = "particl-viral-preset";
const when = (at: number, now: number) => { const t = ago(at, now); return t === "just now" ? t : `${t} ago`; };
const refs = (n: number) => `${n} ${n === 1 ? "ref" : "refs"}`;

export function ViralView({ scope, project, page, items }: { scope: string; project: Project | null; page: ViralPage | "history"; items: LibraryEntry[] }) {
  if (page === "history") return <HistoryView scope={scope} project={project} items={items} />;
  return <Composer key={page} scope={scope} page={page} project={project} items={items} />;
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

/**
 * Hand a take's recipe to the composer of its variant, which prices it again
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
    const state: ViralState = { resolution, prompt: recipe.prompt.slice(0, PROMPT_MAX), source, references: kept };
    try { sessionStorage.setItem(PRESET_KEY, JSON.stringify(state)); } catch { /* the composer starts empty */ }
    shell.goSuite("viral", recipe.variant === "motion-transfer" ? "motion" : "swap");
    ws.toast([kept.length < references.length ? `Loaded the first ${REFERENCE_MAX} of ${references.length} references; this route takes up to ${REFERENCE_MAX}.` : "Same inputs loaded.",
      resolution !== recipe.resolution ? `${recipe.resolution} is not offered here, so it is set to ${resolution}.` : "", "It is priced again before it runs."].filter(Boolean).join(" "));
  };
}

function Composer({ scope, page, project, items }: { scope: string; page: ViralPage; project: Project | null; items: LibraryEntry[] }) {
  const shell = useShell();
  const session = useSession();
  const copy = VIRAL_COPY[page];
  const variant = VIRAL_PAGES[page];
  const sendToTakes = useSendToTakes(scope, project);
  const take = useKeyTake(scope, project?.id ?? null, `viral:${variant}`);
  const [s, set] = useState<ViralState>(() => {
    /* Recreate hands over the finished take's own inputs, already resolved against the Library. */
    try {
      const raw = sessionStorage.getItem(PRESET_KEY);
      if (raw) { sessionStorage.removeItem(PRESET_KEY); return { ...INITIAL_VIRAL, ...(JSON.parse(raw) as Partial<ViralState>) }; }
    } catch { /* starts empty */ }
    return INITIAL_VIRAL;
  });
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
  const place = (medias: ViralMedia[], missing = 0) => {
    const notes: string[] = [];
    set((prev) => { let st = prev; notes.length = 0; for (const m of medias) { const r = addMedia(st, m); st = r.state; if (r.note) notes.push(r.note); } return st; });
    setNote([...(missing ? ["That asset is not in this project's Library."] : []), ...notes].join(" ") || null);
  };
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
  const run = take.run;
  const label = run.phase === "submitting" ? "Submitting…" : run.phase === "running" ? "Rendering…" : credits != null ? `${copy.verb} · ${aboutCredits(credits)}` : copy.verb;
  const estimateFailed = Boolean(!blocked && take.estimate?.key === key && take.estimate.error);
  const running = run.phase === "running" ? run : null;
  const runningTake = running ? viralTakes(items, variant).find((t) => t.id === running.jobId) ?? null : null;

  return (
    <div className="gx-gen vr gx-enter" data-testid="viral-view" data-page={page}>
      <section className="gx-gen-card" aria-label={copy.title}>
        <p className="bz-intro">{copy.intro}</p>
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Resolution</span>
          <div className="gx-chips" role="group" aria-label="Resolution">
            {VIRAL_RESOLUTIONS.map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={s.resolution === r} onClick={() => set({ ...s, resolution: r })}>{r}</button>)}
          </div>
        </div>
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">{VIRAL_COPY.mediaLabel}</span>
          <div className="gx-well vr-well" data-over={over} data-testid="viral-well"
            onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
            onDrop={dropped}>
            {s.source ? (
              <span className="gx-ref vr-source" data-testid="viral-source">
                <span className="gx-ref-thumb">{s.source.url ? <LazyMedia url={s.source.url} kind="video" alt="" name={s.source.name} className="gx-lazy" /> : null}</span>
                <span className="bz-role">video · 0</span>
                <span className="gx-ref-name">{s.source.name}{s.source.seconds != null ? ` · ${Math.round(s.source.seconds)} s` : ""}</span>
                <button type="button" className="gx-ref-x" aria-label={`Remove ${s.source.name}`} onClick={() => set({ ...s, source: null })}>×</button>
              </span>
            ) : null}
            {s.references.map((r, i) => (
              <span className="gx-ref" key={r.id} data-testid="viral-reference">
                <span className="gx-ref-thumb">{r.url ? <LazyMedia url={r.url} kind="image" alt="" name={r.name} className="gx-lazy" /> : null}</span>
                <span className="bz-role">image · {i + 1}</span>
                <span className="gx-ref-name">{r.name}</span>
                <button type="button" className="gx-ref-x" aria-label={`Move ${r.name} earlier`} disabled={i === 0} onClick={() => set(moveReference(s, r.id, -1))}>↑</button>
                <button type="button" className="gx-ref-x" aria-label={`Move ${r.name} later`} disabled={i === s.references.length - 1} onClick={() => set(moveReference(s, r.id, 1))}>↓</button>
                <button type="button" className="gx-ref-x" aria-label={`Remove ${r.name}`} onClick={() => set({ ...s, references: s.references.filter((x) => x.id !== r.id) })}>×</button>
              </span>
            ))}
            {!s.source && !s.references.length ? <span className="gx-well-hint">{VIRAL_COPY.mediaHint}</span> : null}
            {!shell.wide ? <button type="button" className="gx-hbtn" onClick={() => shell.openLibrary("assets")}>Open Library</button> : null}
          </div>
          <span className="cw-dim">{s.references.length} of {REFERENCE_MAX} reference images · order is the order sent</span>
          {s.source && project ? <SourceTools scope={scope} projectId={project.id} source={s.source} full={s.references.length >= REFERENCE_MAX} onFrame={(frame) => place([frame])} onNote={setNote} /> : null}
          {note ? <p className="gx-gen-note" role="status" data-testid="viral-note">{note}</p> : null}
        </div>
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">{copy.promptLabel}</span>
          <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToViral} testId="viral-attach"><textarea className="gx-textarea" aria-label={copy.promptLabel} rows={3} maxLength={PROMPT_MAX} placeholder={copy.promptPlaceholder} value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="viral-prompt" /></PromptAttach>
        </div>
        {reason ? (
          <div className="vr-reason-row">
            <p className="gx-reason" id="vr-reason" data-testid="viral-reason">{reason}</p>
            {estimateFailed && request ? <button type="button" className="gx-hbtn" onClick={() => void take.quote(request, key)} data-testid="viral-reason-retry">Try again</button> : null}
          </div>
        ) : null}
        {run.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="viral-error">{run.error}</p> : null}
        {take.note ? <p className="gx-gen-note" role="status" data-testid="viral-take-note">{take.note}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(reason) || busy} aria-describedby={reason ? "vr-reason" : undefined}
          onClick={() => { if (request) void take.submit(request, key, credits); }} data-testid="viral-generate">{label}</button>
        {credits != null ? <p className="gx-gen-foot" data-testid="viral-foot">An estimate from the live price · filed to this project’s takes</p> : null}
        {running ? (
          <div className="vr-done" role="status" data-testid="viral-running">
            <span className="gx-gen-note">{running.held ? "Held · it starts when credits arrive." : runningTake ? takeWords(runningTake).label : "Queued"} · {aboutCredits(running.credits)}</span>
            {runningTake && canCancel(runningTake, session) ? (
              <span className="vr-done-actions">
                <button type="button" className="gx-hbtn" disabled={take.cancelling === running.jobId} onClick={() => void take.cancel(running.jobId)} data-testid="viral-cancel">{take.cancelling === running.jobId ? "Cancelling…" : "Cancel"}</button>
              </span>
            ) : null}
          </div>
        ) : null}
        {run.phase === "done" ? (
          <div className="vr-done" role="status" data-testid="viral-done">
            <span className="gx-gen-note">Rendered.</span>
            <span className="vr-done-actions">
              <button type="button" className="gx-hbtn" disabled={sendToTakes.opening === run.jobId} onClick={() => { if (run.phase === "done") void sendToTakes.sendTake({ id: run.jobId, createdAt: run.generation.createdAt }); }} data-testid="viral-open-takes">{sendToTakes.opening === run.jobId ? "Opening…" : "Open in Takes"}</button>
              <button type="button" className="gx-hbtn" onClick={() => { take.reset(); shell.goSuite("viral", "history"); }}>Open History</button>
            </span>
          </div>
        ) : null}
      </section>
      <Recent scope={scope} page={page} project={project} items={items} take={take} send={sendToTakes} />
    </div>
  );
}

/**
 * The source's own tools: its first or last frame saved to the project as a
 * full-size still (and placed as the next reference), and the original
 * downloaded. The frame is read from Particl's own copy in the browser; no
 * provider is asked and nothing is charged.
 */
function SourceTools({ scope, projectId, source, full, onFrame, onNote }: { scope: string; projectId: string; source: ViralMedia; full: boolean; onFrame: (frame: ViralMedia) => void; onNote: (note: string | null) => void }) {
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
      else { onFrame(still); onNote(`${edge === "start" ? "Start" : "End"} frame saved to this project and added as a reference · ${frame.width} × ${frame.height} PNG.`); }
    } catch (error) {
      if (alive.current) onNote(error instanceof Error ? error.message : "The frame could not be saved.");
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  return (
    <div className="vr-done-actions vr-source-tools" data-testid="viral-source-tools">
      <button type="button" className="gx-hbtn" disabled={Boolean(busy)} onClick={() => void grab("start")} data-testid="viral-frame-start">{busy === "start" ? "Saving frame…" : "Start frame"}</button>
      <button type="button" className="gx-hbtn" disabled={Boolean(busy)} onClick={() => void grab("end")} data-testid="viral-frame-end">{busy === "end" ? "Saving frame…" : "End frame"}</button>
      <a className="gx-hbtn" href={downloadHref(source.origin, source.sourceId)} download data-testid="viral-source-download">Download source</a>
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
      <div className="gx-gen-results-head"><span className="gx-panel-title">Recent</span><button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "history")}>Open History</button></div>
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
          <button type="button" className="gx-hbtn" onClick={() => onRecreate(take)}>Recreate</button>
          <button type="button" className="gx-hbtn" disabled={!take.url} onClick={onCompare}>Compare</button>
          <button type="button" className="gx-hbtn" disabled={!take.url || opening} onClick={() => onSend(take)}>{opening ? "Opening…" : "Send to Edit"}</button>
          <a className="gx-hbtn" href={downloadHref("generation", take.id)} download data-testid="history-take-download">Download</a>
        </div>
      ) : take.status === "failed" ? (
        <div className="cw-sol-actions"><button type="button" className="gx-hbtn" onClick={() => onRecreate(take)}>Recreate</button></div>
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
