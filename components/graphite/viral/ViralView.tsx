"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { uploadFilesToProject } from "@/lib/workspace/library";
import LazyMedia from "@/components/LazyMedia";
import { useShell } from "@/lib/shell/state";
import { useOpenTake } from "@/lib/shell/use-open-take";
import { useViral, type GenjutsuJob, type Stall } from "@/lib/shell/use-viral";
import {
  HISTORY_ACTIONS, INITIAL_VIRAL, REFERENCE_MAX, RUN_NOTE, STALLED_NOTE, VARIANT_NAME, VIRAL_COPY, VIRAL_PAGES, VIRAL_RESOLUTIONS, addMedia, estimateReason, genjutsuInput, moveReference, originalNote, runInFlight, runStatus, viralBlock, viralMedia,
  type ViralMedia, type ViralPage, type ViralResolution, type ViralState,
} from "@/lib/shell/viral";
import { ago } from "@/lib/workspace/activity";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * Viral = Genjutsu (FINAL_SPEC §1 step 3), on the existing genjutsu-service:
 * Motion Transfer and Object Swap share one composer — exactly one source
 * video (4–30 s, index 0) and up to 30 ordered reference images, a
 * resolution, an optional prompt — and the primary carries the account's
 * live estimate; a stale or missing estimate blocks it with the reason.
 * History is this project's Genjutsu runs — never its estimates — a page at
 * a time, each in words (Queued · Rendering · Checking · Failed · not billed
 * · Done), with Recreate · Compare · Send to Edit (which finds the take in
 * the Library, however far back, and opens it in Takes). Recent beside a
 * composer is that page's own runs. Runs still in flight are read until they
 * land, even ones sent before the page opened.
 */
const cr = (n: number) => `${n.toLocaleString("en-US")} cr`;
const PRESET_KEY = "particl-viral-preset";
const when = (at: number, now: number) => { const t = ago(at, now); return t === "just now" ? t : `${t} ago`; };
const refs = (n: number) => `${n} ${n === 1 ? "ref" : "refs"}`;

export function ViralView({ scope, project, page, items }: { scope: string; project: Project | null; page: ViralPage | "history"; items: LibraryEntry[] }) {
  const viral = useViral(scope, project?.id ?? null, page === "history" ? null : VIRAL_PAGES[page]);
  if (page === "history") return <HistoryView scope={scope} project={project} viral={viral} items={items} />;
  return <Composer key={page} scope={scope} page={page} project={project} viral={viral} items={items} />;
}
type Viral = ReturnType<typeof useViral>;

function findMedia(items: LibraryEntry[], id: string): ViralMedia | null {
  const entry = items.find((e) => e.take.id === id);
  return entry ? viralMedia(entry) : null;
}

/** A finished result opens in Takes, where a take is re-edited — that take (lib/shell/use-open-take). */
function useSendToTakes(scope: string, project: Project | null) {
  const { openTake, opening } = useOpenTake(scope, project);
  const send = (job: GenjutsuJob) => openTake(job.id, job.result?.original?.generationId, job.createdAt);
  return { send, opening };
}

/** A clock for "5 min ago" that ticks while the page is open. */
function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

function Composer({ scope, page, project, viral, items }: { scope: string; page: ViralPage; project: Project | null; viral: Viral; items: LibraryEntry[] }) {
  const shell = useShell();
  const copy = VIRAL_COPY[page];
  const sendToTakes = useSendToTakes(scope, project);
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
  /* Until the account is read, that is the reason — not a connect hint it may not need. */
  const unread = !viral.connection && viral.list.status === "error";
  const account = viral.connection ? null : unread ? viral.listError ?? "The connected account could not be read." : "Reading the connected account…";
  const blocked = viralBlock(s, { connected, owner, hasProject: Boolean(project), account });
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
        {reason ? (
          <div className="vr-reason-row">
            <p className="gx-reason" id="vr-reason" data-testid="viral-reason">{reason}</p>
            {unread && reason === account ? <button type="button" className="gx-hbtn" onClick={() => void viral.refresh()} data-testid="viral-reason-retry">Try again</button> : null}
          </div>
        ) : null}
        {viral.run.phase === "failed" ? <p className="gx-gen-error" role="alert" data-testid="viral-error">{viral.run.error}</p> : null}
        <button type="button" className="gx-primary gx-gen-go" disabled={Boolean(reason) || viral.run.phase === "submitting" || viral.run.phase === "running"} aria-describedby={reason ? "vr-reason" : undefined} onClick={() => void viral.submit()} data-testid="viral-generate">{label}</button>
        {credits != null && viral.estimate?.job ? <p className="gx-gen-foot">{viral.estimate.job.workspaceName} · the account’s own estimate · saved to your takes</p> : null}
        {viral.run.phase === "done" ? (
          <div className="vr-done" role="status" data-testid="viral-done">
            <span className="gx-gen-note">Rendered.</span>
            <span className="vr-done-actions">
              <button type="button" className="gx-hbtn" disabled={sendToTakes.opening === viral.run.job.id} onClick={() => { if (viral.run.phase === "done") void sendToTakes.send(viral.run.job); }} data-testid="viral-open-takes">{sendToTakes.opening === viral.run.job.id ? "Opening…" : "Open in Takes"}</button>
              <button type="button" className="gx-hbtn" onClick={() => { viral.reset(); shell.goSuite("viral", "history"); }}>Open History</button>
            </span>
          </div>
        ) : viral.run.phase === "running" && viral.stalledAs(viral.run.job) ? (
          <div className="vr-done" role="status" data-testid="viral-stalled">
            <span className="gx-gen-note">{STALLED_NOTE[viral.stalledAs(viral.run.job) ?? "unconfirmed"]}</span>
            <span className="vr-done-actions">
              <button type="button" className="gx-hbtn" onClick={() => { if (viral.run.phase === "running") viral.recheck(viral.run.job.id); }}>Check again</button>
              <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "history")}>Open History</button>
            </span>
          </div>
        ) : null}
      </section>
      <Recent page={page} project={project} viral={viral} send={sendToTakes} />
    </div>
  );
}

type Send = ReturnType<typeof useSendToTakes>;
/** The last four runs of this page's variant (the route lists that variant only), each in words, each finished one a way into Takes. */
function Recent({ page, project, viral, send }: { page: ViralPage; project: Project | null; viral: Viral; send: Send }) {
  const shell = useShell();
  const now = useNow();
  const mine = viral.jobs.filter((j) => j.input.variant === VIRAL_PAGES[page]);
  const { status } = viral.list;
  return (
    <section className="gx-gen-results" aria-label="Recent" data-testid="viral-recent" aria-busy={status === "loading"}>
      <div className="gx-gen-results-head"><span className="gx-panel-title">Recent</span><button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "history")}>Open History</button></div>
      {!project ? <p className="cw-dim">Open a project to see its runs.</p>
        : status === "loading" ? <><span className="vr-job vr-skel" aria-hidden="true" /><span className="vr-job vr-skel" aria-hidden="true" /></>
        : status === "error" ? <ListError viral={viral} />
        : mine.length ? mine.slice(0, 4).map((job) => <RunRow key={job.id} job={job} now={now} stalled={viral.stalledAs(job)} onRecheck={viral.recheck} send={send} />)
        : <p className="cw-dim" data-testid="viral-recent-empty">No {VIRAL_COPY[page].title} runs yet.</p>}
      {status === "ready" && viral.listError ? <ListError viral={viral} /> : null}
    </section>
  );
}

function ListError({ viral }: { viral: Viral }) {
  return (
    <div className="vr-list-error" role="alert" data-testid="viral-list-error">
      <span className="gx-gen-error">{viral.listError ?? "The connected account could not be read."}</span>
      <button type="button" className="gx-hbtn" onClick={() => void viral.refresh()}>Try again</button>
    </div>
  );
}

/** The direction a run was given, else what kind of run it was. */
const brief = (job: GenjutsuJob) => job.input.prompt.trim() || VARIANT_NAME[job.input.variant];

function RunRow({ job, now, stalled, onRecheck, send }: { job: GenjutsuJob; now: number; stalled: Stall | null; onRecheck: (id: string) => void; send: Send }) {
  const status = runStatus(job.status);
  const done = job.status === "completed", url = done && job.originalAvailable ? job.result?.original?.asset?.url : null;
  const note = stalled ? STALLED_NOTE[stalled] : RUN_NOTE[job.status];
  return (
    <div className="vr-job" data-status={job.status} data-testid="viral-run">
      <span className="vr-dot" data-tone={status.tone} aria-hidden="true" />
      {/* Recent is one variant's list, so a row names what differs: the direction, resolution and references. */}
      <span className="vr-job-name" title={job.input.prompt || undefined}>{brief(job)}</span>
      <span className="vr-status" data-tone={status.tone} data-testid="viral-run-status">{status.label}</span>
      <span className="cw-dim vr-job-meta">{[job.input.resolution, refs(job.input.references.length), job.status === "failed" ? null : cr(job.quoteCredits), when(job.createdAt, now)].filter(Boolean).join(" · ")}</span>
      {done ? (
        <button type="button" className="gx-hbtn vr-job-act" disabled={!url || send.opening === job.id} title={url ? undefined : originalTitle(job)} onClick={() => void send.send(job)} data-testid="viral-run-open">{send.opening === job.id ? "Opening…" : "Open in Takes"}</button>
      ) : stalled ? (
        <button type="button" className="gx-hbtn vr-job-act" onClick={() => onRecheck(job.id)}>Check again</button>
      ) : null}
      {note ? <span className="cw-dim vr-job-note" data-testid="viral-run-note">{note}</span> : null}
    </div>
  );
}
const originalTitle = (job: GenjutsuJob) => (job.originalAvailability === "deleted" ? "This result was archived." : "The result’s original is not available.");

/* ── History ─────────────────────────────────────────────────────────── */
function HistoryView({ scope, project, viral, items }: { scope: string; project: Project | null; viral: Viral; items: LibraryEntry[] }) {
  const shell = useShell();
  const ws = useWorkspace();
  const now = useNow();
  const sendToTakes = useSendToTakes(scope, project);
  const [compare, setCompare] = useState<GenjutsuJob | null>(null);
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
  const { status, nextCursor, more } = viral.list;
  const owner = viral.connection?.owner ?? true;

  let body: React.ReactNode;
  if (!project) body = <p className="gx-empty" data-testid="history-no-project">Open or create a project to see its runs.</p>;
  else if (status === "loading") body = (
    <div className="gx-gen-grid" aria-hidden="true" data-testid="history-loading">
      {[0, 1, 2, 3].map((i) => <div className="gx-asset" key={i}><div className="gx-asset-thumb vr-skel" /><span className="vr-skel vr-skel--line" /><span className="vr-skel vr-skel--line vr-skel--short" /></div>)}
    </div>
  );
  else if (status === "error") body = <ListError viral={viral} />;
  else if (!owner) body = <p className="gx-empty">Only the workspace owner runs the connected account.</p>;
  else if (!viral.jobs.length) body = (
    <div className="cw-empty vr-empty" data-testid="history-empty">
      <span>No runs in this project yet.</span>
      <span className="vr-empty-actions">
        <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "motion")}>Motion Transfer</button>
        <button type="button" className="gx-hbtn" onClick={() => shell.goSuite("viral", "swap")}>Object Swap</button>
      </span>
    </div>
  );
  else body = (
    <>
      {viral.listError ? <ListError viral={viral} /> : null}
      <div className="gx-gen-grid">
        {viral.jobs.map((job) => <RunCard key={job.id} job={job} now={now} url={resultUrl(job)} stalled={viral.stalledAs(job)} opening={sendToTakes.opening === job.id} onRecheck={viral.recheck} onRecreate={recreate} onCompare={setCompare} onSend={(j) => void sendToTakes.send(j)} />)}
      </div>
      {nextCursor ? (
        <div className="vr-more">
          <button type="button" className="gx-hbtn" disabled={more === "loading"} onClick={() => void viral.loadMore()} data-testid="history-more">{more === "loading" ? "Loading…" : "Load older runs"}</button>
          {more === "error" ? <span className="gx-gen-error" role="alert">Older runs could not be read. Try again.</span> : null}
        </div>
      ) : null}
    </>
  );
  return (
    <div className="vr-history gx-enter" data-testid="history-view" aria-busy={status === "loading"}>
      {body}
      {compare ? <CompareSheet job={compare} source={sourceMedia(compare)?.url ?? null} result={resultUrl(compare)} onClose={() => setCompare(null)} /> : null}
    </div>
  );
}

/** One run: the result and its next steps once it lands; until then, where it stands. */
function RunCard({ job, now, url, stalled, opening, onRecheck, onRecreate, onCompare, onSend }: { job: GenjutsuJob; now: number; url: string | null; stalled: Stall | null; opening: boolean; onRecheck: (id: string) => void; onRecreate: (job: GenjutsuJob) => void; onCompare: (job: GenjutsuJob) => void; onSend: (job: GenjutsuJob) => void }) {
  const status = runStatus(job.status);
  const done = job.status === "completed", flying = runInFlight(job.status) && !stalled;
  const meta = [done ? `${cr(job.quoteCredits)} settled` : job.status === "failed" ? null : cr(job.quoteCredits), when(job.createdAt, now)].filter(Boolean).join(" · ");
  const missing = done && !url ? originalNote(job) : null;
  const note = stalled ? STALLED_NOTE[stalled] : RUN_NOTE[job.status];
  return (
    <div className="gx-asset vr-run" data-testid={done ? "history-result" : "history-run"} data-status={job.status}>
      <div className="gx-asset-thumb">
        {done && url ? <LazyMedia url={url} kind="video" alt="" className="gx-lazy" />
          : <span className="vr-veil" data-tone={missing ? "idle" : status.tone} data-flying={flying}>
            <span className="vr-status" data-tone={missing ? "idle" : status.tone} data-testid="history-run-status">{missing ?? status.label}</span>
            {note ? <span className="vr-veil-note" data-testid="history-run-note">{note}</span> : null}
          </span>}
      </div>
      <span className="gx-asset-name">{VARIANT_NAME[job.input.variant]} · {job.input.resolution}</span>
      {/* What sets one run apart from the next: its references and its direction. */}
      <span className="gx-asset-meta" title={job.input.prompt || undefined}>{[refs(job.input.references.length), job.input.prompt.trim()].filter(Boolean).join(" · ")}</span>
      <span className="gx-asset-meta" title={new Date(job.createdAt).toLocaleString()}>{meta}</span>
      {done ? (
        <div className="cw-sol-actions">
          {HISTORY_ACTIONS.map((a) => {
            const needsOriginal = a !== "Recreate" && !url;
            return (
              <button key={a} type="button" className="gx-hbtn" onClick={() => (a === "Recreate" ? onRecreate(job) : a === "Compare" ? onCompare(job) : onSend(job))}
                disabled={needsOriginal || (a === "Send to Edit" && opening)} title={needsOriginal ? originalTitle(job) : undefined}>{a === "Send to Edit" && opening ? "Opening…" : a}</button>
            );
          })}
        </div>
      ) : job.status === "failed" ? (
        <div className="cw-sol-actions"><button type="button" className="gx-hbtn" onClick={() => onRecreate(job)}>Recreate</button></div>
      ) : stalled ? (
        <div className="cw-sol-actions"><button type="button" className="gx-hbtn" onClick={() => onRecheck(job.id)}>Check again</button></div>
      ) : null}
    </div>
  );
}

/** Original and result on one clock: play, pause and seek together. */
function CompareSheet({ job, source, result, onClose }: { job: GenjutsuJob; source: string | null; result: string | null; onClose: () => void }) {
  const a = useRef<HTMLVideoElement>(null), b = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const both = (fn: (v: HTMLVideoElement) => void) => [a.current, b.current].forEach((v) => v && fn(v));
  const toggle = () => { if (playing) { both((v) => v.pause()); setPlaying(false); } else { both((v) => { void v.play().catch(() => undefined); }); setPlaying(true); } };
  return (
    <div className="gx-veil" onClick={onClose} data-testid="compare-veil">
      <div className="gx-sheet vr-compare" role="dialog" aria-modal="true" aria-label="Compare" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="gx-sheet-head"><span className="gx-panel-title">Compare · {job.input.variant === "motion-transfer" ? "Motion Transfer" : "Object Swap"}</span><button type="button" className="gx-hbtn" onClick={toggle}>{playing ? "Pause" : "Play both"}</button><button type="button" className="gx-hbtn" onClick={onClose}>Close</button></div>
        <div className="vr-compare-grid">
          <figure><figcaption className="gx-eyebrow">Original</figcaption>{source ? <video ref={a} src={source} playsInline preload="metadata" onSeeked={(e) => { if (b.current) b.current.currentTime = e.currentTarget.currentTime; }} controls /> : <p className="cw-dim">The source is no longer in this project.</p>}</figure>
          <figure><figcaption className="gx-eyebrow">Result</figcaption>{result ? <video ref={b} src={result} playsInline preload="metadata" onSeeked={(e) => { if (a.current) a.current.currentTime = e.currentTarget.currentTime; }} controls /> : <p className="cw-dim">The result’s original is not available yet.</p>}</figure>
        </div>
      </div>
    </div>
  );
}
