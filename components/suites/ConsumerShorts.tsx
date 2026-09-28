"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import { libraryInput } from "@/lib/genLibrary";
import { draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import type { Asset, Project } from "@/lib/workbench/studio";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import { SHORTS_ASPECT_RATIOS, SHORTS_LIMITS, consumerShortsInputSchema, shortsClipName, type ConsumerShortsInput, type ShortsAspectRatio, type ShortsPreset } from "@/lib/higgsfield-consumer/shorts-studio";
import { awaitingReconciliation, setAsideUnconfirmed, SET_ASIDE_LABEL } from "@/lib/higgsfield-consumer/job-state";
import { WEBSITE_PREFLIGHT_CODES, chargedEvenIfFails, chargedFailure, creditsText, jobPriceText, recoverableJob, websiteCharge, websiteToolsAnswer, type WebsiteCharge } from "@/lib/higgsfield-consumer/website-charge";
import styles from "./atomik-generate.module.css";

export const shortsEndpoint = "/api/higgsfield/consumer/shorts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
type Source = { id: string; origin: "upload" | "generation"; name: string; url: string; seconds: number | null };
type Draft = { source: Source | null; preset: { id: string; source: "cms" | "user"; name: string } | null; aspectRatio: ShortsAspectRatio };
const empty: Draft = { source: null, preset: null, aspectRatio: "9:16" };
/** `providerJobId` is null on the platform's website tools: a client never sees the account's ids. */
type Clip = { index: number; providerJobId: string | null; state: "collected" | "failed"; reason?: string; availability?: string; original?: unknown };
type Job = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerShortsInput; source: { kind: string; name: string }; pricedSeconds: number; workspaceId: string | null; workspaceName: string | null;
  quoteCredits: number; creditUnit: "higgsfield_credits" | "particl_credits"; quoteExpiresAt: number; quoteExpired?: boolean; providerJobId: string | null;
  /** On the platform's website tools: the workspace's own credits for the whole session, charged even if it yields no clip. */
  charge: WebsiteCharge | null; failureCode?: string | null;
  clips: Clip[]; settlement: { clips: number; collected: number; failed: number } | null; progress?: { clips: number; collected: number; status: string };
  providerReceipt?: unknown; receiptSaved?: boolean; createdAt: number;
};
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = new Set(["quote_expired", "quote_changed", "workspace_changed", "insufficient_credits", "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed", "connection_busy", "price_unknown", "contract_unverified", ...WEBSITE_PREFLIGHT_CODES]);
function draft(value: unknown): Draft {
  if (!record(value)) return empty;
  const s = value.source, p = value.preset;
  return {
    source: record(s) && typeof s.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(s.id) && (s.origin === "upload" || s.origin === "generation")
      ? { id: s.id, origin: s.origin, name: typeof s.name === "string" ? s.name.slice(0, 160) : "Saved original", url: `/api/${s.origin === "upload" ? "uploads" : "media"}/${encodeURIComponent(s.id)}`, seconds: typeof s.seconds === "number" ? s.seconds : null }
      : null,
    preset: record(p) && typeof p.id === "string" && uuid.test(p.id) && (p.source === "cms" || p.source === "user") ? { id: p.id, source: p.source, name: typeof p.name === "string" ? p.name.slice(0, 120) : "" } : null,
    aspectRatio: value.aspectRatio === "16:9" ? "16:9" : "9:16",
  };
}
function parseJob(value: unknown, draftId: string): Job {
  // A session on the platform's website tools names no wallet: its price is the workspace's own credits.
  const charge = websiteCharge(value);
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
      !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
      !charge && (typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" ||
        value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !(value.quoteCredits > 0) || value.quoteCredits > 100000) ||
      typeof value.pricedSeconds !== "number" || !record(value.source) || typeof value.source.name !== "string" || !Array.isArray(value.clips) || value.clips.length > SHORTS_LIMITS.clips)
    throw new Error("The saved Shorts session could not be verified. Refresh before continuing.");
  const clips = value.clips.flatMap((clip) => record(clip) && typeof clip.index === "number" && (typeof clip.providerJobId === "string" || charge && clip.providerJobId === null) && (clip.state === "collected" || clip.state === "failed")
    ? [{ index: clip.index, providerJobId: clip.providerJobId as string | null, state: clip.state as Clip["state"], ...(typeof clip.reason === "string" ? { reason: clip.reason } : {}), ...(typeof clip.availability === "string" ? { availability: clip.availability } : {}), original: clip.original }] : []);
  return { ...(value as unknown as Job), charge, clips, input: consumerShortsInputSchema.parse(value.input) };
}
/** What a failed session says: one never sent was not charged; one that failed after it was sent is charged as quoted. */
const failedNotice = (job: Job, fallback: string) => !job.charge ? fallback
  : job.failureCode === "submission_rejected" ? "The session was never sent. Nothing was charged." : chargedFailure(job.charge.credits, "session");
/** A collected, available clip as a project asset. */
function clipAsset(job: Job, clip: Clip, total: number): Asset | null {
  if (clip.state !== "collected" || clip.availability !== "available" || !record(clip.original) || !record(clip.original.asset)) return null;
  const original = clip.original, asset = clip.original.asset;
  // A platform clip carries no provider id (lib/higgsfield-consumer/client-view.ts).
  if (typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) || !job.charge && original.providerJobId !== clip.providerJobId ||
      asset.url !== `/api/media/${original.generationId}` || asset.kind !== "video") return null;
  return { id: original.generationId, generationId: original.generationId, url: asset.url, kind: "video", mime: "video/mp4", name: shortsClipName(job.source.name, clip.index, total, job.input.preset.name),
    category: "Shorts", description: `Shorts · ${job.input.preset.name || "style"} · ${job.input.aspectRatio} · clip ${clip.index + 1} of ${total} · session ${jobPriceText(job)}`, prompt: "", status: "Draft", version: 1, locked: false, refs: [] };
}

/** Shorts Studio on the connected account: one project video restyled into a
 * set of short clips. Opening only reads saved sessions; styles, quotes and
 * status checks are explicit. */
export function ConsumerShorts({ project, scope, refreshProject, onInput }: {
  project: Project;
  scope: string;
  refreshProject: () => Promise<void>;
  /** The form's current quote input, reported only once the form could send it (null otherwise). */
  onInput?: (input: ConsumerShortsInput | null) => void;
}) {
  const request = useScopedFetch(scope);
  const draftId = project.id;
  const stored = useDraft<Draft>(`subatomik-shorts:${project.id}`, empty), input = draft(stored.value);
  const attemptKey = `particl-consumer-shorts:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}:attempts`;
  /** `allowed`: this person may run it (the owner; any member on a managed workspace). `connected`: it can take work now. */
  const [capability, setCapability] = useState<{ allowed: boolean; connected: boolean; managed: boolean } | null>(null);
  const [presets, setPresets] = useState<{ presets: ShortsPreset[]; complete: boolean; fetchedAt: number } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]), [selectedId, setSelectedId] = useState(""), [attempts, setAttempts] = useState<string[]>([]);
  const [approved, setApproved] = useState(false), [disclosed, setDisclosed] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [search, setSearch] = useState("");
  const [clock, setClock] = useState(() => Date.now()), [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const pending = useRef(false), live = useRef(false), lifecycle = useRef(0), attemptIds = useRef<string[]>([]);
  const normalized = input.source && input.preset ? {
    source: input.source.origin === "upload" ? { uploadId: input.source.id } : { genId: input.source.id },
    preset: { id: input.preset.id, source: input.preset.source, ...(input.preset.name ? { name: input.preset.name } : {}) },
    aspectRatio: input.aspectRatio,
  } : null;
  const seconds = input.source?.seconds ?? null;
  const validation = !input.source ? "Pick one video from this project."
    : !input.preset ? "Choose a style."
    : seconds !== null && (seconds < SHORTS_LIMITS.minSeconds || seconds > SHORTS_LIMITS.maxSeconds) ? `Shorts need a source video of ${SHORTS_LIMITS.minSeconds}–${SHORTS_LIMITS.maxSeconds} seconds.`
    : consumerShortsInputSchema.safeParse(normalized).success ? "" : "Review the source and style.";
  const selected = jobs.find((job) => job.id === selectedId);
  const matches = !!selected && !!normalized && JSON.stringify(selected.input) === JSON.stringify(normalized);
  const unresolved = jobs.some((job) => awaitingReconciliation(job) || (job.status === "quoted" && attempts.includes(job.id)));
  const ready = !!capability?.allowed && capability.connected && !busy;
  const canQuote = ready && !validation && !unresolved && disclosed;
  const canSubmit = ready && selected?.status === "quoted" && matches && approved && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  /* What a host (the /workspace Shorts page) may price: exactly the body this
     form would post, and only while it could post it. */
  const offered = canQuote && normalized ? consumerShortsInputSchema.safeParse(normalized) : null;
  const offeredKey = JSON.stringify(offered?.success ? offered.data : null);
  const report = useRef(onInput);
  useEffect(() => { report.current = onInput; }, [onInput]);
  useEffect(() => { report.current?.(offeredKey === "null" ? null : (JSON.parse(offeredKey) as ConsumerShortsInput)); }, [offeredKey]);
  useEffect(() => () => report.current?.(null), []);
  const change = (patch: Partial<Draft>) => { stored.set((before) => ({ ...draft(before), ...patch })); setApproved(false); setNotice(""); };
  const saveAttempts = (next: string[]) => { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); };
  const confirmAttempts = useCallback((confirmed: Job[]) => {
    const byId = new Map(confirmed.map((job) => [job.id, job]));
    const next = attemptIds.current.filter((id) => { const job = byId.get(id); return !job || awaitingReconciliation(job) || (job.status === "quoted" && job.quoteExpired !== true); });
    try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep the guard when its resolution cannot be saved. */ }
  }, [attemptKey]);
  const json = useCallback(async (url: string, init?: RequestInit) => {
    const response = await request(url, { cache: "no-store", ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !record(result)) throw new RequestError(typeof result?.error === "string" ? result.error : "The request could not be completed. Refresh saved sessions before continuing.", response.status, typeof result?.code === "string" ? result.code : undefined);
    return result;
  }, [request]);
  const post = useCallback((body: Record<string, unknown>) => json(shortsEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [json]);
  const saveJob = (job: Job) => { setJobs((before) => [job, ...before.filter((item) => item.id !== job.id)].slice(0, 25)); setSelectedId(job.id); };
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const token = lifecycle.current; pending.current = true; setBusy("refresh"); setError("");
    try {
      await Promise.resolve();
      if (!live.current || lifecycle.current !== token) return;
      const result = await json(`${shortsEndpoint}?${new URLSearchParams({ draftId })}`);
      if (!live.current || lifecycle.current !== token) return;
      if (!Array.isArray(result.jobs) || result.jobs.length > 25) throw new Error("Saved Shorts sessions could not be loaded.");
      const saved = result.jobs.map((job) => parseJob(job, draftId));
      confirmAttempts(saved); setJobs(saved);
      // A managed workspace runs Shorts on the platform's website tools: only whether they can take work now.
      const website = websiteToolsAnswer(result.websiteTools);
      const connection = record(result.connection) ? result.connection : {};
      setCapability(website ? { allowed: true, connected: website.available, managed: true }
        : { allowed: true, connected: connection.connected === true && connection.requiresReconnect !== true, managed: false });
      setClock(Date.now());
    } catch (reason) {
      if (live.current && lifecycle.current === token) {
        if (reason instanceof RequestError && reason.status === 403) setCapability({ allowed: false, connected: false, managed: false });
        else setError(reason instanceof Error ? reason.message : "Saved Shorts sessions could not be loaded.");
      }
    } finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [json, draftId, confirmAttempts]);
  useEffect(() => {
    live.current = true;
    try { const values = JSON.parse(localStorage.getItem(attemptKey) ?? "[]"); attemptIds.current = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string" && uuid.test(v)).slice(-100) : []; setAttempts(attemptIds.current); } catch { /* A later submit requires writable recovery storage. */ }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [attemptKey, refresh]);
  useEffect(() => { if (!jobs.length) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [jobs.length]);
  async function run<T>(label: string, work: (token: number) => Promise<T>) {
    if (pending.current) return;
    const token = lifecycle.current; pending.current = true; setBusy(label); setError(""); setNotice("");
    try { await work(token); }
    catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "The request could not be completed."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  const loadPresets = (refreshList = false) => run("presets", async (token) => {
    const result = await post({ action: "presets", ...(refreshList ? { refresh: true } : {}) });
    if (!live.current || lifecycle.current !== token) return;
    const value = result.presets;
    if (!record(value) || !Array.isArray(value.presets) || value.presets.length > SHORTS_LIMITS.presets) throw new Error("The connected account’s styles could not be read.");
    const list = value.presets.flatMap((item) => record(item) && typeof item.id === "string" && uuid.test(item.id) && (item.source === "cms" || item.source === "user") && typeof item.name === "string" ? [{ id: item.id, source: item.source as ShortsPreset["source"], name: item.name.slice(0, 120) }] : []);
    setPresets({ presets: list, complete: value.complete !== false, fetchedAt: Number(value.fetchedAt) || Date.now() });
  });
  async function addSource(payload: Parameters<typeof resolveGenInput>[0]) {
    await run("source", async (token) => {
      const asset: GenInputAsset = await resolveGenInput(payload, scope);
      if (!live.current || lifecycle.current !== token) return;
      if (asset.kind !== "video") throw new Error("Shorts need a video file.");
      if (asset.bytes > 50 * 1024 * 1024) throw new Error("The source video must be no larger than 50 MB.");
      change({ source: { id: asset.id, origin: asset.origin, name: asset.name, url: asset.url, seconds: asset.seconds } });
    });
  }
  async function act(action: "quote" | "submit" | "status", job?: Job) {
    if (action === "quote" && !canQuote) return;
    if (action === "submit" && (!canSubmit || !selected)) return;
    if (action === "status" && (!job || clock < (nextPoll[job.id] ?? 0))) return;
    await run(action, async (token) => {
      const target = action === "submit" ? selected! : job;
      if (action === "submit") {
        try { saveAttempts([...new Set([...attemptIds.current, target!.id])].slice(-100)); } catch { throw new Error("Submission recovery could not be saved in this browser. Enable local storage before submitting."); }
        setApproved(false);
      }
      const body = action === "quote" ? { action, draftId, input: consumerShortsInputSchema.parse(normalized), idempotencyKey: crypto.randomUUID() }
        : { action, draftId, id: target!.id, ...(action === "submit" ? target!.charge ? { credits: target!.charge.credits } : { workspaceId: target!.workspaceId, credits: target!.quoteCredits } : {}) };
      let result: Record<string, unknown>;
      try { result = await post(body); }
      catch (reason) {
        if (action === "submit" && reason instanceof RequestError && ([400, 423, 429].includes(reason.status) || (!!reason.code && preflightCodes.has(reason.code)))) {
          try { saveAttempts(attemptIds.current.filter((id) => id !== target!.id)); } catch { /* Keep recovery guarded if storage fails. */ }
          setSelectedId("");
        }
        throw reason;
      }
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseJob(result.job, draftId); confirmAttempts([saved]); saveJob(saved);
      if (action === "quote") setNotice(saved.charge ? "Review the style, source and exact price below before making shorts." : "Review the style, source, wallet and exact price below before making shorts.");
      if (action === "submit") setNotice(saved.status === "failed" ? failedNotice(saved, "The connected account refused this session before it was sent.") : "Session recorded. Use Check result to follow its clips.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll((before) => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        // A finished clip that could not be filed yet (storage full, …) says why.
        const held = record(result.collection) && typeof result.collection.message === "string" ? ` ${result.collection.message.slice(0, 200)}` : "";
        setNotice(saved.status === "completed" ? "Every clip is settled." : saved.status === "failed" ? failedNotice(saved, "The connected account reported that this session produced no clips.") : saved.progress ? `Session ${saved.progress.status}: ${saved.progress.clips} clip${saved.progress.clips === 1 ? "" : "s"} so far.${held}` : `Status checked.${held}`);
      }
    });
  }
  async function save(assets: Asset[]) {
    await run("save", async (token) => {
      const latest = await draftRequest<{ project: Project | null; revision: number }>(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, scope);
      if (!live.current || token !== lifecycle.current) return;
      if (latest.project?.id !== project.id || latest.project.productionProjectId !== project.productionProjectId) throw new Error("The selected project changed. Reload before saving.");
      const missing = assets.filter((asset) => !latest.project!.assets.some((item) => item.generationId === asset.generationId));
      if (missing.length) await writeDraft("/api/workbench", scope, { project: { ...latest.project, assets: [...latest.project.assets, ...missing] }, revision: latest.revision });
      if (!live.current || token !== lifecycle.current) return;
      await refreshProject();
      if (live.current && token === lifecycle.current) setNotice(assets.length === 1 ? "Clip saved to the project library." : `${assets.length} clips saved to the project library.`);
    });
  }
  const statusLabel = (job: Job) => job.status === "completed" ? `${job.settlement?.collected ?? 0} of ${job.settlement?.clips ?? job.clips.length} clips ready` : job.status === "accepted" ? (job.progress ? `In progress · ${job.progress.clips} clip${job.progress.clips === 1 ? "" : "s"}` : "In progress")
    : job.status === "quoted" && job.quoteExpired ? "Expired quote · no dispatch recorded" : setAsideUnconfirmed(job) ? SET_ASIDE_LABEL : job.status === "uncertain" || job.status === "dispatching" || (attempts.includes(job.id) && job.status === "quoted") ? "Submission needs reconciliation" : job.status === "failed" ? "No clips produced" : "Saved quote";
  return <div className={styles.workspace}>
    <div className={styles.columns}>
      <section className={`suite-panel ${styles.creator}`} aria-label={capability?.managed ? "Shorts on the website tools" : "Shorts on the connected account"}>
        <div className="suite-section-heading"><div><h2>Shorts</h2><p>Restyle one project video ({SHORTS_LIMITS.minSeconds}–{SHORTS_LIMITS.maxSeconds} s) into a set of short clips. {capability?.managed ? "One quote in this workspace’s credits covers the whole set." : "One quote in connected credits covers the whole set."}</p></div><span className="suite-badge">{capability?.managed ? "Website tools" : "Connected account"}</span></div>
        {capability?.allowed === false ? <p className="suite-footnote">The workspace owner can make shorts with the connected account.</p> : <>
          {capability && !capability.connected && (capability.managed
            ? <p className="suite-footnote">Website tools are not available for this workspace right now. Saved sessions can still be reviewed.</p>
            : <p className="suite-footnote">Connect or reconnect the owner’s account in <a href="/settings#engines">Workspace settings</a>.</p>)}
          <fieldset className={styles.form} disabled={!capability?.allowed || !!busy} aria-label="Shorts settings">
            <label>Style<select aria-label="Style" value={input.preset ? `${input.preset.source}:${input.preset.id}` : ""} onChange={(e) => { const [kind, id] = e.target.value.split(":"); const preset = presets?.presets.find((p) => p.source === kind && p.id === id); change({ preset: preset ? { id: preset.id, source: preset.source, name: preset.name } : null }); }}>
              <option value="">{presets ? "Choose a style" : busy === "presets" ? "Reading styles…" : "Styles not loaded"}</option>
              {input.preset && !presets?.presets.some((p) => p.id === input.preset!.id) && <option value={`${input.preset.source}:${input.preset.id}`}>{input.preset.name || "Saved style"}</option>}
              {presets?.presets.some((p) => p.source === "cms") && <optgroup label="Library styles">{presets.presets.filter((p) => p.source === "cms").map((p) => <option key={`cms:${p.id}`} value={`cms:${p.id}`}>{p.name}</option>)}</optgroup>}
            </select><small className={styles.hint}>{presets ? `${presets.presets.length.toLocaleString("en-US")} styles${presets.complete ? "" : " (partial listing)"} · read ${new Date(presets.fetchedAt).toLocaleTimeString()}` : capability?.managed ? "Styles are read once an hour." : "The connected account’s styles are read once an hour."}</small></label>
            <label>Orientation<select aria-label="Orientation" value={input.aspectRatio} onChange={(e) => change({ aspectRatio: e.target.value as ShortsAspectRatio })}>
              {SHORTS_ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio === "9:16" ? "Vertical · 9:16" : "Horizontal · 16:9"}</option>)}
            </select><small className={styles.hint}>Clips are 720p.</small></label>
            <div className={styles.references} role="group" aria-label="Source video">
              <span className={styles.hint}>Pick the video to restyle from the library. It is copied to {capability?.managed ? "Particl’s website tools" : "the connected account"} when a quote is requested.</span>
              {input.source && <div className={styles.reference}>
                <video src={input.source.url} muted playsInline preload="metadata" />
                <span>{input.source.name}{input.source.seconds !== null ? ` · ${input.source.seconds.toLocaleString("en-US", { maximumFractionDigits: 1 })} s` : ""}</span>
                <button type="button" aria-label={`Remove ${input.source.name}`} onClick={() => change({ source: null })}><X size={14} /></button>
              </div>}
              {input.source && <label className={styles.checkbox}><input type="checkbox" checked={disclosed} onChange={(e) => setDisclosed(e.target.checked)} />I understand this project original is copied to {capability?.managed ? "Particl’s website tools" : "the connected account"} to prepare the quote.</label>}
            </div>
          </fieldset>
          {validation && <p className={styles.hint} role="status">{validation}</p>}
          <div className={styles.actions}>
            <button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : capability?.managed ? "Get quote" : "Get connected-credit quote"}</button>
            <button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void loadPresets(!!presets)}><RefreshCw size={14} />{presets ? "Reload styles" : "Load styles"}</button>
            <button type="button" className="suite-button" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} />Refresh saved sessions</button>
          </div>
          {unresolved && <p role="status" className="suite-footnote">{capability?.managed ? "A submission needs reconciliation. It is never sent again: check it below." : "A submission needs reconciliation. It is never sent again: check it below, or set it aside in Workspace › Engines."}</p>}
          {selected?.status === "quoted" && selected.charge && <div className={styles.quote} aria-label="Shorts quote">
            <strong>{creditsText(selected.charge.credits)}</strong>
            <small>Shorts · {selected.source.name} · {selected.input.preset.name || "style"} · {selected.input.aspectRatio} · priced for {selected.pricedSeconds.toLocaleString("en-US")} s</small>
            <p>{matches ? "One price for the whole set of clips, whatever their number." : "The source or settings changed. Request a new quote before making shorts."}</p>
            {/* Said before approval (owner decision): the approved price stands however many clips the session yields, even none. */}
            <p role="note" className={styles.charge}>{chargedEvenIfFails(selected.charge.credits, "session")}</p>
            <p className="suite-footnote">{selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The exact price is checked again before submission.</p>
            <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {creditsText(selected.charge.credits)} for this set of shorts, even if it yields no clip.</label>
            <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Make shorts · ${creditsText(selected.charge.credits)}`}</button>
          </div>}
          {selected?.status === "quoted" && !selected.charge && <div className={styles.quote} aria-label="Connected-credit quote">
            <strong>{selected.quoteCredits.toLocaleString("en-US")} connected credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
            <small>Shorts · {selected.source.name} · {selected.input.preset.name || "style"} · {selected.input.aspectRatio} · priced for {selected.pricedSeconds.toLocaleString("en-US")} s</small>
            <p>{matches ? "One price for the whole set of clips, whatever their number." : "The source or settings changed. Request a new quote before making shorts."}</p>
            <p className="suite-footnote">{selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The connected account’s active wallet is shared across its clients; the wallet and exact price are checked again before submission. Output belongs to the connected account and is billed in its credits.</p>
            <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {selected.quoteCredits.toLocaleString("en-US")} connected credits to {selected.workspaceName} for this set of shorts.</label>
            <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Make shorts · ${selected.quoteCredits.toLocaleString("en-US")} connected credits`}</button>
          </div>}
        </>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </section>
      <aside className={`suite-panel ${styles.library}`} aria-label="Project library">
        <div className="suite-section-heading"><div><h2>Project library</h2><p>Pick the video to restyle.</p></div></div>
        <label className={styles.search}>Search assets<input aria-label="Search project assets" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <GenAssetLibrary workbenchProjectId={project.id} projectName={project.name} allowWorkspaceBrowse initialBrowseScope="project" search={search}
          onUseAsset={(asset) => void addSource(asset)} onUseReference={(asset) => void addSource(libraryInput(asset))} />
      </aside>
    </div>
    <section className="suite-panel" aria-label="Saved Shorts sessions">
      <div className="suite-section-heading"><div><h2>Sessions</h2><p>Saved quotes, submissions and collected clips for this project.</p></div></div>
      {!jobs.length ? <p className="suite-footnote">No saved Shorts sessions yet.</p> : <div className={styles.jobs}>{jobs.map((job) => {
        const total = job.settlement?.clips ?? job.clips.length, assets = job.clips.flatMap((clip) => { const asset = clipAsset(job, clip, total); return asset ? [asset] : []; });
        const unsaved = assets.filter((asset) => !project.assets.some((item) => item.generationId === asset.generationId));
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}>
          <div><strong>{statusLabel(job)}</strong><span>{jobPriceText(job)}</span></div>
          <p>{job.source.name}</p>
          <small>{job.input.preset.name || "Style"} · {job.input.aspectRatio} · {job.pricedSeconds.toLocaleString("en-US")} s{job.charge ? "" : ` · ${job.workspaceName}`}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { setSelectedId(job.id); setApproved(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || recoverableJob(job)) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability?.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved request" : "Check result"}</button>}
          {job.status === "completed" && <>
            {job.settlement && job.settlement.failed > 0 && <small>{job.settlement.failed} clip{job.settlement.failed === 1 ? "" : "s"} failed{job.charge ? "" : " on the connected account"}; the session was charged once{job.charge ? ", as quoted" : ""}.</small>}
            <div className={styles.jobs} role="list" aria-label="Clips">{job.clips.map((clip) => {
              const asset = clipAsset(job, clip, total), saved = asset && project.assets.some((item) => item.generationId === asset.generationId);
              return <div key={clip.index} role="listitem" className={styles.result}>
                <small>Clip {clip.index + 1} of {total}{clip.state === "failed" ? ` · ${clip.reason === "deleted" ? "deleted from the library" : "failed"}` : clip.availability === "deleted" ? " · deleted" : ""}</small>
                {asset && <video src={asset.url} controls playsInline preload="metadata" />}
                {asset && <div className={styles.actions}><a className="suite-text-button" href={`${asset.url}?download=1`} download>Download clip</a><button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void save([asset])}>{saved ? "In project library" : "Save to project"}</button></div>}
              </div>;
            })}</div>
            {assets.length > 1 && <div className={styles.actions}><button type="button" className="suite-primary" disabled={!!busy || !unsaved.length} onClick={() => void save(unsaved)}>{unsaved.length ? `Save all ${unsaved.length} clips to project` : "All clips in project library"}</button></div>}
          </>}
        </article>;
      })}</div>}
    </section>
  </div>;
}
