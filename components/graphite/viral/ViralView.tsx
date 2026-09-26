"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { uploadFilesToProject } from "@/lib/workspace/library";
import LazyMedia from "@/components/LazyMedia";
import { useShell } from "@/lib/shell/state";
import { useViral, type GenjutsuJob } from "@/lib/shell/use-viral";
import {
  HISTORY_ACTIONS, INITIAL_VIRAL, REFERENCE_MAX, VIRAL_COPY, VIRAL_RESOLUTIONS, addMedia, estimateReason, genjutsuInput, mirrorSeek, moveReference, type MirrorMark, viralBlock, viralMedia,
  type ViralMedia, type ViralPage, type ViralResolution, type ViralState,
} from "@/lib/shell/viral";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { resumeLine, resumePhase } from "@/lib/higgsfield-consumer/resume";
import { useClock } from "../ResumedJobs";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3), on the existing genjutsu-service:
 * Motion Transfer and Object Swap share one composer — exactly one source
 * video (4–30 s, index 0) and up to 30 ordered reference images, a
 * resolution, an optional prompt — and the primary carries the account's
 * live estimate; a stale or missing estimate blocks it with the reason.
 * History is this project's Genjutsu results with Recreate · Compare · Send
 * to Edit.
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const PRESET_KEY = "particl-viral-preset";

export function ViralView({ scope, project, page, items }: { scope: string; project: Project | null; page: ViralPage | "history"; items: LibraryEntry[] }) {
  const viral = useViral(project?.id ?? null, Boolean(scope));
  if (page === "history") return <HistoryView viral={viral} items={items} />;
  return <Composer key={page} scope={scope} page={page} project={project} viral={viral} items={items} />;
}
type Viral = ReturnType<typeof useViral>;

function findMedia(items: LibraryEntry[], id: string): ViralMedia | null {
  const entry = items.find((e) => e.take.id === id);
  return entry ? viralMedia(entry) : null;
}

function Composer({ scope, page, project, viral, items }: { scope: string; page: ViralPage; project: Project | null; viral: Viral; items: LibraryEntry[] }) {
  const shell = useShell();
  const ws = useWorkspace();
  const copy = VIRAL_COPY[page];
  const [s, set] = useState<ViralState>(() => {
    /* Recreate hands over the finished job's own inputs; they are resolved against the Library below. */
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

  const connected = viral.connection?.connected ?? false, owner = viral.connection?.owner ?? true;
  const blocked = viralBlock(s, { connected, owner, hasProject: Boolean(project) });
  const input = useMemo(() => (blocked ? null : genjutsuInput(page, s)), [blocked, page, s]);
  const key = JSON.stringify(input);
  /* The live estimate: read for exactly this input, re-read when it changes or expires. */
  const quote = viral.quote, estimateKey = viral.estimate?.key, estimateExpires = viral.estimate?.expiresAt ?? 0, runPhase = viral.run.phase;
  useEffect(() => {
    if (!input || runPhase === "submitting" || runPhase === "running") return;
    if (estimateKey === key && estimateExpires > now) return;
    const timer = setTimeout(() => void quote(input, key), 600);
    return () => clearTimeout(timer);
  }, [input, key, quote, estimateKey, estimateExpires, now, runPhase]);
  const reason = blocked ?? estimateReason(viral.estimate, key, now);
  const credits = !reason && viral.estimate ? viral.estimate.credits : null;

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
  const label = viral.run.phase === "submitting" ? "Submitting…" : viral.run.phase === "running" ? "Rendering…" : credits != null ? `${copy.verb} · ${cr(credits)}` : copy.verb;

  return (
    <div className="gx-gen vr gx-enter" data-testid="viral-view" data-page={page}>
      <section className="gx-gen-card" aria-label={copy.title}>
        <p className="bz-intro">{copy.intro}</p>
        {viral.listError ? <p className="gx-gen-error" role="alert">{viral.listError}</p> : null}
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">Resolution</span>
          <div className="gx-chips" role="group" aria-label="Resolution">
            {(viral.capabilities?.resolutions ?? VIRAL_RESOLUTIONS).map((r) => <button key={r} type="button" className="gx-chip" aria-pressed={s.resolution === r} onClick={() => set({ ...s, resolution: r as ViralResolution })}>{r}</button>)}
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
          {note ? <p className="gx-gen-note" role="status" data-testid="viral-note">{note}</p> : null}
        </div>
        <div className="gx-gen-row">
          <span className="gx-eyebrow" data-functional-label="">{copy.promptLabel}</span>
          <PromptAttach scope={scope} projectId={project?.id} onAttach={attachToViral} testId="viral-attach"><textarea className="gx-textarea" aria-label={copy.promptLabel} rows={3} placeholder={copy.promptPlaceholder} value={s.prompt} onChange={(e) => set({ ...s, prompt: e.target.value })} data-testid="viral-prompt" /></PromptAttach>
        </div>
        {reason ? <p className="gx-reason" id="vr-reason" data-testid="viral-reason">{reason}</p> : null}
        {viral.run.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="viral-error">{viral.run.error}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(reason) || viral.run.phase === "submitting" || viral.run.phase === "running"} aria-describedby={reason ? "vr-reason" : undefined} onClick={() => void viral.submit()} data-testid="viral-generate">{label}</button>
        {credits != null && viral.estimate?.job ? <p className="gx-gen-foot">{viral.estimate.job.workspaceName} · the account’s own estimate · saved to your takes</p> : null}
        {viral.run.phase === "done" ? <p className="gx-gen-note" role="status" data-testid="viral-done">Rendered. It is in History, in Takes and in Library › Assets. <button type="button" className="cw-link" onClick={() => { viral.reset(); shell.goSuite("viral", "history"); }}>Open History</button></p> : null}
      </section>
      <section className="gx-gen-results" aria-label="Recent">
        <div className="gx-gen-results-head"><span className="gx-panel-title">Recent</span><button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "history")}>Open History</button></div>
        {viral.jobs.filter((j) => j.input.variant === (page === "motion" ? "motion-transfer" : "object-swap")).slice(0, 4).map((job) => <JobRow key={job.id} job={job} problem={viral.problems[job.id]} now={now} />)}
        {!viral.jobs.length ? <p className="cw-dim">Nothing run in this project yet.</p> : null}
        {ws.state.projectId ? null : <p className="cw-dim">Open a project to see its results.</p>}
      </section>
    </div>
  );
}

/** One job: its state in one word and how long it has been going; a problem says what to do. */
function JobRow({ job, problem, now }: { job: GenjutsuJob; problem?: string; now: number }) {
  return (
    <div className="vr-job gx-resumed-row" data-status={job.status} data-tone={resumePhase(job).tone} data-testid="viral-job">
      <span className="gx-resumed-dot" aria-hidden="true" />
      <span className="vr-job-name">{job.input.variant === "motion-transfer" ? "Motion Transfer" : "Object Swap"} · {job.input.resolution}</span>
      <span className="gx-resumed-state">{job.status === "completed" ? `${cr(job.quoteCredits)} settled` : resumeLine(job, now)}</span>
      {problem ? <p className="gx-resumed-problem" role="status">{problem}</p> : null}
    </div>
  );
}

/* ── History ─────────────────────────────────────────────────────────── */
function HistoryView({ viral, items }: { viral: Viral; items: LibraryEntry[] }) {
  const shell = useShell();
  const ws = useWorkspace();
  const [compare, setCompare] = useState<GenjutsuJob | null>(null);
  const finished = viral.jobs.filter((j) => j.status === "completed");
  const others = viral.jobs.filter((j) => j.status !== "completed");
  const now = useClock(others.length ? 30_000 : 0);
  const resultUrl = (job: GenjutsuJob) => (job.originalAvailable && typeof job.result?.original?.asset?.url === "string" ? job.result.original.asset.url : null);
  const sourceMedia = (job: GenjutsuJob) => { const id = job.input.source.genId ? `generation:${job.input.source.genId}` : `upload:${job.input.source.uploadId}`; return findMedia(items, id); };
  const recreate = (job: GenjutsuJob) => {
    const source = sourceMedia(job);
    const references = job.input.references.map((r) => findMedia(items, r.genId ? `generation:${r.genId}` : `upload:${r.uploadId}`)).filter((m): m is ViralMedia => Boolean(m));
    if (!source || references.length !== job.input.references.length) { ws.toast("Some of this job's originals are no longer in the project, so it cannot be recreated exactly."); return; }
    try { sessionStorage.setItem(PRESET_KEY, JSON.stringify({ resolution: job.input.resolution, prompt: job.input.prompt, source, references } satisfies ViralState)); } catch { /* the composer starts empty */ }
    shell.goSuite("viral", job.input.variant === "motion-transfer" ? "motion" : "swap");
    ws.toast("Same inputs loaded — the account prices it again before it runs.");
  };
  const sendToEdit = (job: GenjutsuJob) => {
    const id = job.result?.original?.generationId;
    if (!id) { ws.toast("This result's original is not available yet."); return; }
    ws.dispatch({ type: "patch", patch: { selKind: "take", selId: `generation:${id}` } });
    /* Takes opens the selected take in Seedance Edit; Edit & Sound is the cut. */
    shell.goSuite("studio", "takes");
  };
  return (
    <div className="vr-history gx-enter" data-testid="history-view">
      {viral.listError ? <p className="gx-gen-error" role="alert">{viral.listError}</p> : null}
      {!viral.jobs.length ? <p className="cw-empty">{viral.connection ? "No Genjutsu results in this project yet. Motion Transfer and Object Swap results land here, retained as original bytes." : "Reading the connected account…"}</p> : null}
      <div className="gx-gen-grid">
        {finished.map((job) => {
          const url = resultUrl(job);
          return (
            <div className="gx-asset" key={job.id} data-testid="history-result">
              <div className="gx-asset-thumb">{url ? <LazyMedia url={url} kind="video" alt="" className="gx-lazy" /> : <span className="gx-badge">RETAINED</span>}</div>
              <span className="gx-asset-name">{job.input.variant === "motion-transfer" ? "Motion Transfer" : "Object Swap"} · {job.input.resolution}</span>
              <span className="gx-asset-meta">{cr(job.quoteCredits)} settled · {job.input.references.length} refs</span>
              <div className="cw-sol-actions">
                {HISTORY_ACTIONS.map((a) => (
                  <button key={a} type="button" className="gx-hbtn" onClick={() => (a === "Recreate" ? recreate(job) : a === "Compare" ? setCompare(job) : sendToEdit(job))}
                    disabled={a === "Compare" && !url} title={a === "Compare" && !url ? "The result’s original is not available yet." : undefined}>{a}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {others.length ? <div className="vr-others">{others.map((job) => <JobRow key={job.id} job={job} problem={viral.problems[job.id]} now={now} />)}</div> : null}
      {compare ? <CompareSheet job={compare} source={sourceMedia(compare)?.url ?? null} result={resultUrl(compare)} onClose={() => setCompare(null)} /> : null}
    </div>
  );
}

/** Original and result on one clock: play, pause and seek together. */
function CompareSheet({ job, source, result, onClose }: { job: GenjutsuJob; source: string | null; result: string | null; onClose: () => void }) {
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
        <div className="gx-sheet-head"><span className="gx-panel-title">Compare · {job.input.variant === "motion-transfer" ? "Motion Transfer" : "Object Swap"}</span><button type="button" className="gx-hbtn" onClick={toggle}>{playing ? "Pause" : "Play both"}</button><button type="button" className="gx-hbtn" onClick={onClose}>Close</button></div>
        <div className="vr-compare-grid">
          <figure><figcaption className="gx-eyebrow">Original</figcaption>{source ? <video ref={a} src={source} playsInline preload="metadata" onSeeked={(e) => follow(e.currentTarget, b.current)} controls /> : <p className="cw-dim">The source is no longer in this project.</p>}</figure>
          <figure><figcaption className="gx-eyebrow">Result</figcaption>{result ? <video ref={b} src={result} playsInline preload="metadata" onSeeked={(e) => follow(e.currentTarget, a.current)} controls /> : <p className="cw-dim">The result’s original is not available yet.</p>}</figure>
        </div>
      </div>
    </div>
  );
}
