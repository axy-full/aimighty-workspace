"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { Asset, Project } from "@/lib/workbench/studio";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import { CONSUMER_VIDEO_MODES, CONSUMER_VIDEO_RATIOS, CONSUMER_VIDEO_RESOLUTIONS, consumerVideoInputSchema, type ConsumerVideoInput } from "@/lib/higgsfield-consumer/video-contract";
import styles from "./consumer-marketing-video.module.css";

type Job = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerVideoInput; workspaceId: string; workspaceName: string; quoteCredits: number;
  creditUnit: "higgsfield_credits"; quoteExpiresAt: number; providerJobId: string | null;
  result?: unknown; providerReceipt?: unknown; createdAt: number;
};
type Capability = { owner: boolean; connected: boolean; suspended: boolean };
const endpoint = "/api/higgsfield/consumer/video";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
class VideoRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = new Set(["quote_expired", "quote_changed", "workspace_changed", "unapproved_adjustment", "insufficient_credits", "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed", "connection_busy"]);
const sameInput = (a: ConsumerVideoInput, b: ConsumerVideoInput) => JSON.stringify(a) === JSON.stringify(b);
const modeLabels: Record<NonNullable<ConsumerVideoInput["mode"]>, string> = {
  ugc: "UGC · presenter",
  ugc_how_to: "UGC · how-to",
  ugc_unboxing: "UGC · unboxing",
  product_showcase: "Product showcase",
  product_review: "Product review",
  tv_spot: "TV spot",
  wild_card: "Wild card",
  ugc_virtual_try_on: "UGC · virtual try-on",
  virtual_try_on: "Virtual try-on",
};
const modeLabel = (mode: ConsumerVideoInput["mode"]) => mode === undefined ? "UGC (provider default)" : modeLabels[mode];
function parseJob(value: unknown, draftId: string): Job {
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
    !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
    typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" || value.workspaceName.length > 200 ||
    value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !Number.isFinite(value.quoteCredits) || value.quoteCredits <= 0 || value.quoteCredits > 100000 ||
    !(value.providerJobId === null || typeof value.providerJobId === "string" && uuid.test(value.providerJobId)) ||
    typeof value.quoteExpiresAt !== "number" || !Number.isFinite(value.quoteExpiresAt) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt))
    throw new Error("The saved marketing job could not be verified. Refresh before continuing.");
  return { ...value, input: consumerVideoInputSchema.parse(value.input) } as Job;
}

/** Only the service's collected local original can become a project asset. */
function originalAsset(job: Job): Asset | null {
  if (job.status !== "completed" || !record(job.result) || !record(job.result.original)) return null;
  const original = job.result.original, asset = original.asset;
  if (!record(asset) || typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) ||
    !job.providerJobId || typeof original.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(original.sha256) ||
    ![original.bytes, original.width, original.height, original.seconds].every(value => typeof value === "number" && Number.isFinite(value) && value > 0) ||
    original.providerJobId !== job.providerJobId || original.creditUnit !== "higgsfield_credits" || original.credits !== job.quoteCredits ||
    asset.generationId !== original.generationId || asset.kind !== "video" || asset.mime !== "video/mp4" || asset.url !== `/api/media/${original.generationId}`) return null;
  return { id: original.generationId, generationId: original.generationId, url: asset.url,
    name: `Marketing video · ${job.input.prompt.slice(0, 100)}`, kind: "video", mime: "video/mp4", category: "Campaign video",
    description: `Higgsfield Marketing Video · ${job.input.duration}s · ${job.input.resolution} · ${job.input.aspectRatio}`,
    prompt: job.input.prompt, status: "Draft", version: 1, locked: false, refs: [] };
}
function defaultInput(project: Project): ConsumerVideoInput {
  const brief = project.moleculr;
  return { prompt: [brief?.productName && `Create a product video for ${brief.productName}.`, brief?.productDescription,
    brief?.creative?.direction, project.direction, "Use only the supplied product facts. Do not invent claims or testimonials."].filter(Boolean).join("\n\n").slice(0, 5000),
    duration: brief?.creative?.seconds && brief.creative.seconds >= 12 && brief.creative.seconds <= 15 ? brief.creative.seconds : 15,
    resolution: "720p", aspectRatio: CONSUMER_VIDEO_RATIOS.includes(project.aspect as ConsumerVideoInput["aspectRatio"]) ? project.aspect as ConsumerVideoInput["aspectRatio"] : "16:9", generateAudio: true, mode: "product_showcase" };
}
const draftEvent = "particl-consumer-video-draft";
const subscribe = (notify: () => void) => { window.addEventListener("storage", notify); window.addEventListener(draftEvent, notify); return () => { window.removeEventListener("storage", notify); window.removeEventListener(draftEvent, notify); }; };
const noStoredDraft = () => null;

/** Captured project and account scope own every request. Opening/reloading only
 * reads local job records; generation and provider status checks are explicit. */
export function ConsumerMarketingVideo({ project, scope, enabled, onSave, onAsset }: {
  project: Project; scope: string; enabled: boolean; onSave?: () => Promise<boolean>;
  onAsset?: (asset: Asset, draftId: string) => Promise<void>;
}) {
  const request = useScopedFetch(scope);
  const draftId = project.id;
  const storageKey = `particl-consumer-video:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}`;
  const attemptKey = `${storageKey}:attempts`;
  const readDraft = useCallback(() => { try { return localStorage.getItem(storageKey); } catch { return null; } }, [storageKey]);
  const stored = useSyncExternalStore(subscribe, readDraft, noStoredDraft);
  const [edit, setEdit] = useState<ConsumerVideoInput | null>(null);
  let input = edit ?? defaultInput(project);
  if (!edit && stored) try { const parsed = consumerVideoInputSchema.safeParse(JSON.parse(stored)); if (parsed.success) input = parsed.data; } catch { /* Keep the project brief editable. */ }
  const [capability, setCapability] = useState<Capability | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [attempts, setAttempts] = useState<string[]>([]);
  const [walletReviewed, setWalletReviewed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const [refreshedAt, setRefreshedAt] = useState(0);
  const pending = useRef(false), lifecycle = useRef(0);
  const attemptIds = useRef<string[]>([]);
  const live = useRef(false);
  const valid = consumerVideoInputSchema.safeParse(input).success;
  const selected = jobs.find(job => job.id === selectedId);
  const matches = !!selected && sameInput(selected.input, input);
  const unresolved = jobs.some(job => ["dispatching", "uncertain"].includes(job.status) || (job.status === "quoted" && attempts.includes(job.id) && refreshedAt <= job.quoteExpiresAt));
  const canQuote = enabled && capability?.owner && capability.connected && !capability.suspended && !busy && valid && !unresolved;
  const canSubmit = canQuote && selected?.status === "quoted" && matches && walletReviewed && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  const update = (next: ConsumerVideoInput) => {
    setEdit(next); setWalletReviewed(false); setNotice("");
    try { localStorage.setItem(storageKey, JSON.stringify(next)); window.dispatchEvent(new Event(draftEvent)); } catch { /* Editing remains available; submission recovery requires storage below. */ }
  };
  const saveJob = (job: Job) => { setJobs(before => [job, ...before.filter(item => item.id !== job.id)].slice(0, 25)); setSelectedId(job.id); setClock(Date.now()); };
  const json = useCallback(async (url: string, init?: RequestInit) => {
    const response = await request(url, { cache: "no-store", ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !record(result)) throw new VideoRequestError(typeof result?.error === "string" ? result.error : "The marketing request could not be completed. Refresh saved jobs before continuing.", response.status, typeof result?.code === "string" ? result.code : undefined);
    return result;
  }, [request]);
  const refresh = useCallback(async () => {
    if (!enabled || pending.current) return;
    const token = lifecycle.current;
    pending.current = true; setBusy("refresh"); setError("");
    try {
      const me = await json("/api/me");
      if (!live.current || lifecycle.current !== token) return;
      if (typeof me.id !== "string" || !record(me.workspace) || typeof me.workspace.id !== "string" || workbenchScopeFor(me.workspace.id, me.id) !== scope)
        throw new Error("Your account or workspace changed. Reload this project before continuing.");
      if (me.owner !== true) { setCapability({ owner: false, connected: false, suspended: false }); setJobs([]); return; }
      const [connection, result] = await Promise.all([json("/api/higgsfield/consumer/connection"), json(`${endpoint}?${new URLSearchParams({ draftId })}`)]);
      if (!live.current || lifecycle.current !== token) return;
      if (!Array.isArray(result.jobs) || result.jobs.length > 25) throw new Error("Saved marketing jobs could not be loaded.");
      const saved = result.jobs.map(job => parseJob(job, draftId));
      setJobs(saved); setCapability({ owner: true, connected: connection.connected === true && connection.requiresReconnect !== true, suspended: me.workspace.suspended === true });
      setClock(Date.now()); setRefreshedAt(Date.now());
    } catch (reason) { if (live.current && lifecycle.current === token) { setCapability(null); setError(reason instanceof Error ? reason.message : "Saved marketing jobs could not be loaded."); } }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [enabled, json, scope, draftId, setBusy, setError, setCapability, setJobs, setClock, setRefreshedAt]);
  useEffect(() => {
    live.current = true;
    try { const values = JSON.parse(localStorage.getItem(attemptKey) ?? "[]"); attemptIds.current = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string" && uuid.test(value)).slice(-100) : []; setAttempts(attemptIds.current); } catch { /* A later submit requires writable recovery storage. */ }
    void refresh();
    // Invalidate every asynchronous action started by this mounted project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [attemptKey, refresh]);
  useEffect(() => {
    if (!jobs.length) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [jobs.length]);
  async function act(action: "quote" | "submit" | "status", job = selected) {
    if (!enabled || pending.current || !capability?.owner) return;
    if (action === "quote" && !canQuote) return;
    if (action === "submit" && (!canSubmit || !job || job.id !== selectedId)) return;
    if (action === "status" && (!job || !(job.status === "accepted" || job.status === "uncertain" && job.providerReceipt) || Date.now() < (nextPoll[job.id] ?? 0))) return;
    const token = lifecycle.current;
    pending.current = true; setBusy(action); setError(""); setNotice("");
    try {
      if (action === "quote" && onSave && !await onSave()) throw new Error("Save this project before requesting a video quote.");
      if (!live.current || lifecycle.current !== token) return;
      if (action === "submit") {
        const next = [...new Set([...attemptIds.current, job!.id])].slice(-100);
        try { localStorage.setItem(attemptKey, JSON.stringify(next)); }
        catch { throw new Error("Submission recovery could not be saved in this browser. Enable local storage before generating."); }
        attemptIds.current = next; setAttempts(next); setWalletReviewed(false);
      }
      const body = action === "quote" ? { action, draftId, input: consumerVideoInputSchema.parse(input), idempotencyKey: crypto.randomUUID() }
        : { action, draftId, id: job!.id, ...(action === "submit" ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits } : {}) };
      const result = await json(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseJob(result.job, draftId); saveJob(saved);
      if (action === "quote") { update(saved.input); setNotice("Review the complete prompt, settings, wallet and price below."); }
      if (action === "submit") setNotice("Request recorded. Use Check video result to recover its progress.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll(before => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        setNotice(saved.status === "completed" ? originalAsset(saved) ? "The original video is ready to add to this project." : "The video completed, but its original receipt is unavailable. Refresh saved jobs before adding it." : "Status checked. The saved job remains available here.");
      }
    } catch (reason) {
      if (live.current && lifecycle.current === token) {
        // These responses are produced before paid admission. Transport errors,
        // generic 5xx and ambiguous receipts retain the durable attempt guard.
        if (action === "submit" && job && reason instanceof VideoRequestError &&
          ([400, 423, 429].includes(reason.status) || !!reason.code && preflightCodes.has(reason.code))) {
          const next = attemptIds.current.filter(id => id !== job.id);
          try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep recovery guarded if storage fails. */ }
          setSelectedId(""); setWalletReviewed(false);
        }
        setError(reason instanceof Error ? reason.message : "The request could not be completed. Refresh saved jobs before continuing.");
      }
    }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  async function attach(job: Job, asset: Asset) {
    if (!enabled || pending.current || !onAsset) return;
    const token = lifecycle.current; pending.current = true; setBusy("attach"); setError("");
    try { await onAsset(asset, draftId); if (live.current && lifecycle.current === token) setNotice("Original video saved in the project library and campaign takes."); }
    catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "The original could not be attached."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  return <section className={`suite-panel ${styles.panel}`} aria-label="Higgsfield Marketing Video">
    <div className="suite-section-heading"><div><h2>Higgsfield Marketing Video</h2><p>Create a campaign video from an editable prompt using the workspace owner’s connected Higgsfield account.</p></div><span className="suite-badge">Higgsfield · Video</span></div>
    {!enabled ? <p className="suite-footnote">Open and save a project to continue.</p> : capability?.owner === false ? <p className="suite-footnote">The workspace owner can use this connected account. Your Particl generation tools remain available above.</p> : <>
      <p className="suite-footnote">This prompt flow sends the text and settings below. Product photos, cast images and the reference ad above use the separate Particl engine workflow.</p>
      {capability && !capability.connected && <p className="suite-footnote">Connect or reconnect the owner’s Higgsfield marketing account in <a href="/settings#engines">Workspace settings <ArrowUpRight size={12}/></a>.</p>}
      {capability?.suspended && <p role="status">Rendering is paused for this workspace. Saved jobs can still be reviewed.</p>}
      <fieldset disabled={!enabled || !capability?.owner || !!busy} className="suite-fields">
        <label>Creative format<select aria-label="Higgsfield video creative format" value={input.mode ?? ""} onChange={event => update({ ...input, mode: event.target.value as NonNullable<ConsumerVideoInput["mode"]> })}>
          {input.mode === undefined && <option value="">UGC (provider default)</option>}
          {CONSUMER_VIDEO_MODES.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}
        </select></label>
        <p className="suite-footnote">UGC and try-on formats may introduce a presenter or model. Review generated dialogue and commercial claims before publishing.</p>
        <label className={styles.prompt}>Video prompt<textarea aria-label="Higgsfield video prompt" rows={6} maxLength={5000} value={input.prompt} onChange={event => update({ ...input, prompt: event.target.value })}/><small>{input.prompt.length}/5000</small></label>
        <div className={styles.settings}>
          <label>Duration<select aria-label="Higgsfield video duration" value={input.duration} onChange={event => update({ ...input, duration: Number(event.target.value) })}>{[12,13,14,15].map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label>
          <label>Resolution<select aria-label="Higgsfield video resolution" value={input.resolution} onChange={event => update({ ...input, resolution: event.target.value as ConsumerVideoInput["resolution"] })}>{CONSUMER_VIDEO_RESOLUTIONS.map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Aspect ratio<select aria-label="Higgsfield video aspect ratio" value={input.aspectRatio} onChange={event => update({ ...input, aspectRatio: event.target.value as ConsumerVideoInput["aspectRatio"] })}>{CONSUMER_VIDEO_RATIOS.map(value => <option key={value}>{value}</option>)}</select></label>
        </div>
        <label className={styles.checkbox}><input type="checkbox" checked={input.generateAudio} onChange={event => update({ ...input, generateAudio: event.target.checked })}/>Generate audio</label>
      </fieldset>
      <div className={styles.actions}><button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : "Get Higgsfield video quote"}</button><button type="button" className="suite-button" disabled={!enabled || !!busy} onClick={() => void refresh()}><RefreshCw size={14}/>Refresh saved video jobs</button></div>
      {unresolved && <p role="status" className="suite-footnote">A submission needs reconciliation. Refresh saved jobs to recover it; this request will not be submitted again.</p>}
      {selected?.status === "quoted" && <div className={styles.quote} aria-label="Higgsfield video quote">
        <strong>{selected.quoteCredits} Higgsfield credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
        <small>Creative format · {modeLabel(selected.input.mode)}</small>
        <p>{matches ? `${selected.input.duration} seconds · ${selected.input.resolution} · ${selected.input.aspectRatio} · ${selected.input.generateAudio ? "with audio" : "without audio"}` : "The prompt or settings changed. Request a new quote before generating."}</p>
        <p className="suite-footnote">{selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} Higgsfield’s active wallet is shared across its connected clients. Particl checks the wallet and exact price again before submission.</p>
        <label className={styles.checkbox}><input type="checkbox" checked={walletReviewed} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={event => setWalletReviewed(event.target.checked)}/>Charge {selected.quoteCredits} Higgsfield credits to {selected.workspaceName} for this video.</label>
        <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Generate video · ${selected.quoteCredits} Higgsfield credits`}</button>
      </div>}
      {!!jobs.length && <div className={styles.jobs} aria-label="Saved Higgsfield video jobs">{jobs.map(job => {
        const original = originalAsset(job), attached = original && project.assets.some(asset => asset.generationId === original.generationId);
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}><div><strong>{job.status === "completed" ? original ? "Original ready" : "Completed · original unavailable" : job.status === "accepted" ? "Video in progress" : job.status === "quoted" && attempts.includes(job.id) && refreshedAt > job.quoteExpiresAt ? "Expired quote · no dispatch recorded" : job.status === "uncertain" || job.status === "dispatching" || attempts.includes(job.id) && job.status === "quoted" ? "Submission needs reconciliation" : job.status === "failed" ? "Video failed" : "Saved quote"}</strong><span>{job.quoteCredits} Higgsfield credits</span></div>
          <p>{job.input.prompt}</p><small>{modeLabel(job.input.mode)} · {job.input.duration}s · {job.input.resolution} · {job.input.aspectRatio} · {job.workspaceName}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { update(job.input); setSelectedId(job.id); setWalletReviewed(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || job.status === "uncertain" && !!job.providerReceipt) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability?.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved video request" : "Check video result"}</button>}
          {original && <div className={styles.actions}><a className="suite-text-button" href={`${original.url}?download=1`} download>Download original</a>{onAsset && <button type="button" className="suite-button" disabled={!!busy || !!attached} onClick={() => void attach(job, original)}>{attached ? "In project library" : "Add original to project"}</button>}</div>}
          {job.status === "completed" && !original && <p className="suite-footnote">The original receipt is unavailable. Refresh saved jobs before adding this video.</p>}
        </article>;
      })}</div>}
    </>}
    {notice && <p role="status" className="suite-footnote">{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
