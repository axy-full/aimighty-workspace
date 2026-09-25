"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { previewAttrs } from "@/lib/preview";
import { RefreshCw, X } from "lucide-react";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { GenInputAsset } from "@/lib/genAssetInput";
import { draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import type { Asset, Project } from "@/lib/workbench/studio";
import {
  DUBBING_LANGUAGES,
  REFRAME_ASPECT_RATIOS,
  REFRAME_MAX_SECONDS,
  REFRAME_RESOLUTIONS,
  consumerVoiceToolInputSchema,
  dubbingLanguageName,
  findVoiceTool,
  voiceToolResultName,
  type ConnectedVoice,
  type ConsumerVoiceToolInput,
  type VideoAnalysisReport,
  type VoiceToolName,
} from "@/lib/higgsfield-consumer/voice-tools";
import styles from "./atomik-generate.module.css";

export const voiceEndpoint = "/api/higgsfield/consumer/audio-tools";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export type VoiceCapabilities = { voice: boolean; dubbing: boolean; analysis: boolean; reframe: boolean; languages: { code: string; name: string }[] };
export type VoiceSource = { id: string; origin: "upload" | "generation"; kind: "video"; name: string; url: string };
type AspectRatio = (typeof REFRAME_ASPECT_RATIOS)[number];
type Resolution = (typeof REFRAME_RESOLUTIONS)[number];
type Draft = { source: VoiceSource | null; voiceId: string; voiceType: "preset" | "element"; voiceName: string; language: string; aspectRatio: AspectRatio | ""; resolution: Resolution };
const empty: Draft = { source: null, voiceId: "", voiceType: "preset", voiceName: "", language: "", aspectRatio: "", resolution: "720p" };
type Job = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerVoiceToolInput; tool: { name: VoiceToolName; label: string; suffix: string; output: "video" | "report" }; source: { kind: string; name: string };
  priceSource: "get_cost"; pricedSeconds?: number; workspaceId: string; workspaceName: string; quoteCredits: number; creditUnit: "higgsfield_credits"; quoteExpiresAt: number;
  quoteExpired?: boolean; providerJobId: string | null; result?: unknown; providerReceipt?: unknown; originalAvailable?: boolean; originalAvailability?: string; createdAt: number;
};
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = new Set(["quote_expired", "quote_changed", "workspace_changed", "unapproved_adjustment", "insufficient_credits", "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed", "connection_busy", "price_unknown", "contract_unverified", "analysis_disabled", "tool_unknown"]);
const recoverable = (job: Job) => ["dispatching", "accepted", "uncertain"].includes(job.status);
const retain = (jobs: Job[], attempted: string[]) => {
  const pin = (job: Job) => recoverable(job) || (job.status === "quoted" && attempted.includes(job.id));
  return [...jobs.filter(pin), ...jobs.filter((job) => !pin(job))].slice(0, 25);
};
function draft(value: unknown): Draft {
  if (!record(value)) return empty;
  const source = record(value.source) && typeof value.source.id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.source.id) && ["upload", "generation"].includes(String(value.source.origin))
    ? { id: value.source.id, origin: value.source.origin as VoiceSource["origin"], kind: "video" as const, name: typeof value.source.name === "string" ? value.source.name.slice(0, 160) : "Saved original", url: `/api/${value.source.origin === "upload" ? "uploads" : "media"}/${encodeURIComponent(value.source.id)}` }
    : null;
  return {
    source,
    voiceId: typeof value.voiceId === "string" ? value.voiceId.slice(0, 200) : "",
    voiceType: value.voiceType === "element" ? "element" : "preset",
    voiceName: typeof value.voiceName === "string" ? value.voiceName.slice(0, 160) : "",
    language: DUBBING_LANGUAGES.some((entry) => entry.code === value.language) ? String(value.language) : "",
    aspectRatio: REFRAME_ASPECT_RATIOS.includes(value.aspectRatio as AspectRatio) ? (value.aspectRatio as AspectRatio) : "",
    resolution: REFRAME_RESOLUTIONS.includes(value.resolution as Resolution) ? (value.resolution as Resolution) : "720p",
  };
}
export function parseVoiceJob(value: unknown, draftId: string): Job {
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
      !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
      typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" || value.workspaceName.length > 200 ||
      value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !Number.isFinite(value.quoteCredits) || value.quoteCredits <= 0 || value.quoteCredits > 100000 ||
      !(value.providerJobId === null || (typeof value.providerJobId === "string" && uuid.test(value.providerJobId))) ||
      typeof value.quoteExpiresAt !== "number" || typeof value.createdAt !== "number" || value.priceSource !== "get_cost" ||
      !record(value.tool) || !findVoiceTool(String(value.tool.name)) || !record(value.source) || typeof value.source.name !== "string")
    throw new Error("The saved voice job could not be verified. Refresh before continuing.");
  const tool = findVoiceTool(String(value.tool.name))!;
  const pricedSeconds = typeof value.pricedSeconds === "number" && Number.isFinite(value.pricedSeconds) && value.pricedSeconds > 0 && value.pricedSeconds <= REFRAME_MAX_SECONDS ? value.pricedSeconds : undefined;
  return { ...value, pricedSeconds, tool: { name: tool.name, label: tool.label, suffix: tool.suffix, output: tool.output }, source: { kind: String(value.source.kind), name: value.source.name.slice(0, 160) }, input: consumerVoiceToolInputSchema.parse(value.input) } as Job;
}
/** Only the service's collected local original can become a project asset. */
function originalAsset(job: Job): (Asset & { mime: string }) | null {
  if (job.tool.output !== "video" || job.status !== "completed" || job.originalAvailable !== true || job.originalAvailability !== "available" || !record(job.result) || !record(job.result.original)) return null;
  const original = job.result.original, asset = original.asset;
  if (!record(asset) || typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) || !job.providerJobId ||
      original.providerJobId !== job.providerJobId || original.creditUnit !== "higgsfield_credits" || original.credits !== job.quoteCredits ||
      typeof original.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(original.sha256) || typeof original.bytes !== "number" || original.bytes <= 0 ||
      asset.generationId !== original.generationId || typeof asset.mime !== "string" || asset.url !== `/api/media/${original.generationId}` || asset.kind !== "video") return null;
  const name = voiceToolResultName(findVoiceTool(job.tool.name)!, job.source.name, job.input);
  return { id: original.generationId, generationId: original.generationId, url: asset.url, kind: "video", mime: asset.mime, name, category: job.tool.name === "reframe" ? "Tools" : "Voice",
    description: `${job.tool.label} · ${settingsSummary(job)} · ${job.quoteCredits} connected credits`, prompt: "", status: "Draft", version: 1, locked: false, refs: [] };
}
function report(job: Job): VideoAnalysisReport | null {
  if (job.tool.output !== "report" || job.status !== "completed" || !record(job.result) || !record(job.result.report)) return null;
  const value = job.result.report;
  const figures = Array.isArray(value.figures) ? value.figures.flatMap((f) => (record(f) && typeof f.label === "string" && typeof f.value === "number" ? [{ key: String(f.key), label: f.label.slice(0, 80), value: f.value }] : [])).slice(0, 24) : [];
  const scenes = Array.isArray(value.scenes) ? value.scenes.flatMap((s) => (record(s) && typeof s.index === "number" ? [{ index: s.index, ...(typeof s.start === "number" ? { start: s.start } : {}), ...(typeof s.end === "number" ? { end: s.end } : {}), text: typeof s.text === "string" ? s.text.slice(0, 2000) : "" }] : [])).slice(0, 200) : [];
  return { figures, scenes, sceneCount: typeof value.sceneCount === "number" ? value.sceneCount : scenes.length, summary: typeof value.summary === "string" ? value.summary.slice(0, 2000) : "" };
}
/** A completed analysis filed as a project note: figures and scenes as text, no media. */
function reportAsset(job: Job): Asset | null {
  const value = report(job);
  if (!value || !job.providerJobId) return null;
  const lines = [
    `${job.tool.label} · the connected account’s estimate, not a measurement.`,
    value.summary,
    ...value.figures.map((figure) => `${figure.label}: ${figure.value}`),
    `${value.sceneCount} scene${value.sceneCount === 1 ? "" : "s"}`,
    ...value.scenes.map((scene) => `Scene ${scene.index + 1}${scene.start !== undefined ? ` (${scene.start}${scene.end !== undefined ? `–${scene.end}` : ""} s)` : ""}: ${scene.text}`),
  ].filter(Boolean);
  return { id: `analysis_${job.providerJobId}`, url: `/api/workbench/media/analysis/${job.providerJobId}`, kind: "document", mime: "text/plain", name: voiceToolResultName(findVoiceTool(job.tool.name)!, job.source.name),
    category: "Voice", description: lines.join("\n").slice(0, 8000), prompt: "", status: "Draft", version: 1, locked: false, refs: [] };
}
const settingsSummary = (job: Pick<Job, "input"> & { pricedSeconds?: number }) =>
  job.input.voice ? `voice ${job.input.voice.name || job.input.voice.id}` : job.input.targetLanguage ? `into ${dubbingLanguageName(job.input.targetLanguage)}`
    : job.input.aspectRatio ? `to ${job.input.aspectRatio} at ${job.input.resolution}${job.pricedSeconds ? ` · ${job.pricedSeconds.toLocaleString("en-US")} s` : ""}` : "scene-by-scene report";
export type VoiceToolsHandle = { addSource: (asset: GenInputAsset) => void };

/** Change voice, Dub and (when enabled) Analyse video on the connected account,
 * over one project video. Opening only reads local records; the voice list,
 * quotes and status checks are explicit. */
export function AtomikVoiceTools({ project, scope, tool, capability, capabilities, jobs: savedJobs, revision, refreshProject, ref }: {
  project: Project; scope: string; tool: VoiceToolName; capability: { owner: boolean; connected: boolean; suspended: boolean };
  capabilities: VoiceCapabilities | null; jobs: Job[]; revision: number; refreshProject: () => Promise<void>; ref?: Ref<VoiceToolsHandle>;
}) {
  const request = useScopedFetch(scope);
  const draftId = project.id;
  const definition = findVoiceTool(tool)!;
  const stored = useDraft<Draft>(`atomik-voice:${project.id}`, empty), input = draft(stored.value);
  const attemptKey = `particl-consumer-voice:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}:attempts`;
  const [jobs, setJobs] = useState<Job[]>([]), [selectedId, setSelectedId] = useState(""), [attempts, setAttempts] = useState<string[]>([]);
  const [voices, setVoices] = useState<{ voices: ConnectedVoice[]; complete: boolean; fetchedAt: number } | null>(null);
  const [approved, setApproved] = useState(false), [disclosed, setDisclosed] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [clock, setClock] = useState(() => Date.now()), [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const pending = useRef(false), live = useRef(false), lifecycle = useRef(0), attemptIds = useRef<string[]>([]);
  const languages = capabilities?.languages.length ? capabilities.languages : DUBBING_LANGUAGES;
  const normalized: ConsumerVoiceToolInput = {
    tool,
    source: input.source ? (input.source.origin === "upload" ? { uploadId: input.source.id } : { genId: input.source.id }) : { uploadId: "" },
    ...(tool === "voice_change" ? { voice: { id: input.voiceId, type: input.voiceType, ...(input.voiceName ? { name: input.voiceName } : {}) } } : {}),
    ...(tool === "dubbing" ? { targetLanguage: input.language as ConsumerVoiceToolInput["targetLanguage"] } : {}),
    ...(tool === "reframe" ? { aspectRatio: (input.aspectRatio || undefined) as ConsumerVoiceToolInput["aspectRatio"], resolution: input.resolution } : {}),
  };
  const validation = !input.source ? `${definition.label} needs one video from this project.`
    : tool === "voice_change" && !input.voiceId ? "Choose a voice from the connected account."
    : tool === "dubbing" && !input.language ? "Choose the language to dub into."
    : tool === "reframe" && !input.aspectRatio ? "Choose the target aspect ratio."
    : consumerVoiceToolInputSchema.safeParse(normalized).success ? "" : "Review the source file and settings.";
  const selected = jobs.find((job) => job.id === selectedId);
  const matches = !!selected && JSON.stringify(selected.input) === JSON.stringify(normalized);
  const unresolved = jobs.some((job) => ["dispatching", "uncertain"].includes(job.status) || (job.status === "quoted" && attempts.includes(job.id)));
  const enabled = tool === "video_analysis" ? capabilities?.analysis === true : tool === "dubbing" ? capabilities?.dubbing !== false : tool === "reframe" ? capabilities?.reframe === true : capabilities?.voice !== false;
  const ready = capability.owner && capability.connected && !capability.suspended && !busy && enabled;
  const canQuote = ready && !validation && !unresolved && disclosed;
  const canSubmit = ready && selected?.status === "quoted" && matches && approved && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  const change = (patch: Partial<Draft>) => { stored.set((before) => ({ ...draft(before), ...patch })); setApproved(false); setNotice(""); };
  const confirmAttempts = useCallback((confirmed: Job[]) => {
    const byId = new Map(confirmed.map((job) => [job.id, job]));
    const next = attemptIds.current.filter((id) => { const job = byId.get(id); return !job || ["dispatching", "uncertain"].includes(job.status) || (job.status === "quoted" && job.quoteExpired !== true); });
    try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep the guard when its resolution cannot be saved. */ }
  }, [attemptKey]);
  const saveJob = (job: Job) => { setJobs((before) => retain([job, ...before.filter((item) => item.id !== job.id)], attemptIds.current)); setSelectedId(job.id); };
  const json = useCallback(async (url: string, init?: RequestInit) => {
    const response = await request(url, { cache: "no-store", ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !record(result)) throw new RequestError(typeof result?.error === "string" ? result.error : "The request could not be completed. Refresh saved jobs before continuing.", response.status, typeof result?.code === "string" ? result.code : undefined);
    return result;
  }, [request]);
  const post = useCallback((body: Record<string, unknown>) => json(voiceEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [json]);
  useEffect(() => {
    live.current = true;
    try { const values = JSON.parse(localStorage.getItem(attemptKey) ?? "[]"); attemptIds.current = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string" && uuid.test(v)).slice(-100) : []; setAttempts(attemptIds.current); } catch { /* A later submit requires writable recovery storage. */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [attemptKey]);
  // The parent refreshes the saved list; this panel adopts it and re-checks its attempt guard.
  useEffect(() => { confirmAttempts(savedJobs); setJobs(retain(savedJobs, attemptIds.current)); setClock(Date.now()); }, [savedJobs, revision, confirmAttempts]);
  useEffect(() => { if (!jobs.length) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [jobs.length]);
  const loadVoices = useCallback(async (refresh = false) => {
    if (pending.current) return;
    const token = lifecycle.current; pending.current = true; setBusy("voices"); setError("");
    try {
      // A remounted panel (strict-mode double effects) must not read the listing twice.
      await Promise.resolve();
      if (!live.current || lifecycle.current !== token) return;
      const result = await post({ action: "voices", ...(refresh ? { refresh: true } : {}) });
      if (!live.current || lifecycle.current !== token) return;
      const value = result.voices;
      if (!record(value) || !Array.isArray(value.voices) || value.voices.length > 500) throw new Error("The connected account’s voices could not be read.");
      const list = value.voices.flatMap((item) => record(item) && typeof item.id === "string" && (item.type === "preset" || item.type === "element") && typeof item.name === "string" ? [{ id: item.id, type: item.type as ConnectedVoice["type"], name: item.name.slice(0, 160), ...(typeof item.language === "string" ? { language: item.language } : {}) }] : []);
      setVoices({ voices: list, complete: value.complete !== false, fetchedAt: Number(value.fetchedAt) || Date.now() });
    } catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "The connected account’s voices could not be read."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [post]);
  // The voice list is read on demand (cached an hour server-side), like the parent reads the catalogue.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (tool === "voice_change" && !voices && capability.connected && capability.owner) void loadVoices(); }, [tool, voices, capability.connected, capability.owner, loadVoices]);
  useImperativeHandle(ref, () => ({
    addSource: (asset) => {
      if (asset.kind !== "video") { setError(`${definition.label} needs a video file.`); return; }
      if (asset.bytes > 50 * 1024 * 1024) { setError("The source video must be no larger than 50 MB."); return; }
      setError("");
      change({ source: { id: asset.id, origin: asset.origin, kind: "video", name: asset.name, url: asset.url } });
    },
  }));
  async function act(action: "quote" | "submit" | "status", job: Job | null | undefined = selected) {
    if (pending.current || !capability.owner) return;
    if (action === "quote" && !canQuote) return;
    if (action === "submit" && (!canSubmit || !job || job.id !== selectedId)) return;
    if (action === "status" && (!job || !(job.status === "accepted" || (job.status === "uncertain" && job.providerReceipt)) || clock < (nextPoll[job.id] ?? 0))) return;
    const token = lifecycle.current;
    pending.current = true; setBusy(action); setError(""); setNotice("");
    try {
      if (action === "submit") {
        const next = [...new Set([...attemptIds.current, job!.id])].slice(-100);
        try { localStorage.setItem(attemptKey, JSON.stringify(next)); } catch { throw new Error("Submission recovery could not be saved in this browser. Enable local storage before running this tool."); }
        attemptIds.current = next; setAttempts(next); setApproved(false);
      }
      const body = action === "quote" ? { action, draftId, input: consumerVoiceToolInputSchema.parse(normalized), idempotencyKey: crypto.randomUUID() }
        : { action, draftId, id: job!.id, ...(action === "submit" ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits } : {}) };
      const result = await post(body);
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseVoiceJob(result.job, draftId); confirmAttempts([saved]); saveJob(saved);
      if (action === "quote") setNotice("Review the source, settings, wallet and exact price below before running this tool.");
      if (action === "submit") setNotice("Request recorded. Use Check result to recover its progress.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll((before) => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        setNotice(saved.status === "completed" ? (saved.tool.output === "report" ? "The report is ready to save to this project." : originalAsset(saved) ? "The original is ready to save to this project." : "The job completed, but its original is unavailable. Refresh saved jobs before saving it.")
          : saved.status === "failed" ? "The connected account reported that this job failed." : "Status checked. The saved job remains available here.");
      }
    } catch (reason) {
      if (live.current && lifecycle.current === token) {
        if (action === "submit" && job && reason instanceof RequestError && ([400, 403, 423, 429].includes(reason.status) || (!!reason.code && preflightCodes.has(reason.code)))) {
          const next = attemptIds.current.filter((id) => id !== job.id);
          try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep recovery guarded if storage fails. */ }
          setSelectedId(""); setApproved(false);
        }
        setError(reason instanceof Error ? reason.message : "The request could not be completed. Refresh saved jobs before continuing.");
      }
    } finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  async function save(asset: Asset) {
    if (pending.current) return;
    const token = lifecycle.current; pending.current = true; setBusy("save"); setError("");
    try {
      const latest = await draftRequest<{ project: Project | null; revision: number }>(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, scope);
      if (!live.current || token !== lifecycle.current) return;
      if (latest.project?.id !== project.id || latest.project.productionProjectId !== project.productionProjectId) throw new Error("The selected project changed. Reload before saving.");
      if (!latest.project.assets.some((item) => item.id === asset.id))
        await writeDraft("/api/workbench", scope, { project: { ...latest.project, assets: [...latest.project.assets, asset] }, revision: latest.revision });
      if (!live.current || token !== lifecycle.current) return;
      await refreshProject();
      if (live.current && token === lifecycle.current) setNotice(asset.kind === "document" ? "Report saved to the project library as a note." : "Original saved to the project library.");
    } catch (reason) { if (live.current && token === lifecycle.current) setError(reason instanceof Error ? reason.message : "The result could not be saved in this project."); }
    finally { if (token === lifecycle.current) { pending.current = false; if (live.current) setBusy(""); } }
  }
  const presets = voices?.voices.filter((voice) => voice.type === "preset") ?? [], custom = voices?.voices.filter((voice) => voice.type === "element") ?? [];
  return <>
    <fieldset className={styles.form} disabled={!capability.owner || !!busy} aria-label={`${definition.label} settings`}>
      <p className={styles.hint} aria-label="Selected tool">{definition.label}: {definition.description} Needs one video from this project; no prompt.</p>
      {!enabled && <p role="status" className="suite-footnote">{definition.label} is not available on the connected account: it advertises no price for this tool{tool === "video_analysis" ? " and its report format is unverified" : ""}.</p>}
      {tool === "voice_change" && <label>Voice<select aria-label="Voice" value={input.voiceId ? `${input.voiceType}:${input.voiceId}` : ""} onChange={(e) => { const [type, ...rest] = e.target.value.split(":"); const id = rest.join(":"); const voice = voices?.voices.find((v) => v.type === type && v.id === id); change({ voiceId: voice?.id ?? "", voiceType: voice?.type ?? "preset", voiceName: voice?.name ?? "" }); }}>
        <option value="">{voices ? "Choose a voice" : busy === "voices" ? "Reading voices…" : "Voices not loaded"}</option>
        {presets.length > 0 && <optgroup label="Preset voices">{presets.map((voice) => <option key={`preset:${voice.id}`} value={`preset:${voice.id}`}>{voice.name}{voice.language ? ` · ${voice.language}` : ""}</option>)}</optgroup>}
        {custom.length > 0 && <optgroup label="Your voices">{custom.map((voice) => <option key={`element:${voice.id}`} value={`element:${voice.id}`}>{voice.name}{voice.language ? ` · ${voice.language}` : ""}</option>)}</optgroup>}
      </select><small className={styles.hint}>{voices ? `${voices.voices.length} voices${voices.complete ? "" : " (partial listing)"} · read ${new Date(voices.fetchedAt).toLocaleTimeString()}` : "The connected account’s voices are read once an hour."}</small></label>}
      {tool === "reframe" && <label>Target aspect ratio<select aria-label="Target aspect ratio" value={input.aspectRatio} onChange={(e) => change({ aspectRatio: e.target.value as AspectRatio | "" })}>
        <option value="">Choose an aspect ratio</option>
        {REFRAME_ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
      </select></label>}
      {tool === "reframe" && <label>Resolution<select aria-label="Resolution" value={input.resolution} onChange={(e) => change({ resolution: e.target.value as Resolution })}>
        {REFRAME_RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
      </select><small className={styles.hint}>Priced for the video’s stored length, up to {REFRAME_MAX_SECONDS} s.</small></label>}
      {tool === "dubbing" && <label>Target language<select aria-label="Target language" value={input.language} onChange={(e) => change({ language: e.target.value })}>
        <option value="">Choose a language</option>
        {languages.map((entry) => <option key={entry.code} value={entry.code}>{entry.name} · {entry.code}</option>)}
      </select><small className={styles.hint}>The spoken language is detected by the connected account; only the target is chosen here.</small></label>}
      <div className={styles.references} role="group" aria-label="Source file">
        <span className={styles.hint}>Pick the video this tool works on from the library. The source is copied to the connected account when a quote is requested.</span>
        <div className={styles.chips} role="group" aria-label="Source role"><button type="button" aria-pressed="true">video source</button></div>
        {input.source && <div className={styles.reference}>
          <video src={input.source.url} muted playsInline preload="metadata" {...previewAttrs({ url: input.source.url, kind: "video", name: "Source" })} />
          <span>{input.source.name}</span>
          <button type="button" aria-label={`Remove ${input.source.name}`} onClick={() => change({ source: null })}><X size={14} /></button>
        </div>}
        {input.source && <label className={styles.checkbox}><input type="checkbox" checked={disclosed} onChange={(e) => setDisclosed(e.target.checked)} />I understand this project original is copied to the connected account to prepare the quote.</label>}
      </div>
    </fieldset>
    {validation && <p className={styles.hint} role="status">{validation}</p>}
    <div className={styles.actions}>
      <button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : "Get connected-credit quote"}</button>
      {tool === "voice_change" && <button type="button" className="suite-button" disabled={!!busy || !capability.connected} onClick={() => void loadVoices(true)}><RefreshCw size={14} />Reload voices</button>}
    </div>
    {unresolved && <p role="status" className="suite-footnote">A submission needs reconciliation. Refresh saved jobs to recover it; this request will not be submitted again.</p>}
    {selected?.status === "quoted" && <div className={styles.quote} aria-label="Connected-credit quote">
      <strong>{selected.quoteCredits} connected credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
      <small>{selected.tool.label} · {selected.source.name} · {settingsSummary(selected)}</small>
      <p>{matches ? `Result: ${selected.tool.output === "report" ? "a scene-by-scene report filed as a project note" : `“${voiceToolResultName(definition, selected.source.name, selected.input)}”`}.` : "The source or settings changed. Request a new quote before running this tool."}</p>
      <p className="suite-footnote">Priced by the connected account’s own quote for exactly these settings. {selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The connected account’s active wallet is shared across its clients; the wallet and exact price are checked again before submission. Output belongs to the connected account and is billed in its credits.</p>
      <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {selected.quoteCredits} connected credits to {selected.workspaceName} for this {selected.tool.label.toLowerCase()} run.</label>
      <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `${selected.tool.label} · ${selected.quoteCredits} connected credits`}</button>
    </div>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <section className={styles.jobs} aria-label="Saved voice jobs">
      <h3 className={styles.hint}>Voice and reframe jobs</h3>
      {!jobs.length ? <p className="suite-footnote">No saved voice or reframe jobs yet.</p> : jobs.map((job) => {
        const original = originalAsset(job), note = reportAsset(job), analysis = report(job);
        const saved = (original && project.assets.some((asset) => asset.generationId === original.generationId)) || (note && project.assets.some((asset) => asset.id === note.id));
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}>
          <div><strong>{job.status === "completed" ? (original ? "Original ready" : analysis ? "Report ready" : job.originalAvailability === "deleted" ? "Completed · original deleted" : "Completed · original unavailable") : job.status === "accepted" ? "In progress" : job.status === "quoted" && job.quoteExpired === true ? "Expired quote · no dispatch recorded" : job.status === "uncertain" || job.status === "dispatching" || (attempts.includes(job.id) && job.status === "quoted") ? "Submission needs reconciliation" : job.status === "failed" ? "Job failed" : "Saved quote"}</strong><span>{job.quoteCredits} connected credits</span></div>
          <p>{job.source.name}</p>
          <small>{job.tool.label} · {settingsSummary(job)} · {job.workspaceName}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { setSelectedId(job.id); setApproved(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || (job.status === "uncertain" && !!job.providerReceipt)) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved request" : "Check result"}</button>}
          {original && <div className={styles.result}>
            <video src={original.url} controls playsInline preload="metadata" {...previewAttrs({ url: original.url, kind: "video", name: "Result" })} />
            <div className={styles.actions}><a className="suite-text-button" href={`${original.url}?download=1`} download>Download original</a><button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void save(original)}>{saved ? "In project library" : "Save to project"}</button></div>
          </div>}
          {analysis && note && <div className={styles.result} aria-label="Analysis report">
            <small>The connected account’s estimate for this video, not a measurement.</small>
            {analysis.summary && <p>{analysis.summary}</p>}
            {analysis.figures.length > 0 && <dl className={styles.figures}>{analysis.figures.map((figure) => <div key={figure.key}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>}
            <small>{analysis.sceneCount} scene{analysis.sceneCount === 1 ? "" : "s"}</small>
            {analysis.scenes.slice(0, 12).map((scene) => <p key={scene.index}>Scene {scene.index + 1}{scene.start !== undefined ? ` · ${scene.start}${scene.end !== undefined ? `–${scene.end}` : ""} s` : ""}{scene.text ? ` · ${scene.text}` : ""}</p>)}
            <div className={styles.actions}><button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void save(note)}>{saved ? "In project library" : "Save report to project"}</button></div>
          </div>}
          {job.status === "completed" && !original && !analysis && <p className="suite-footnote">{job.originalAvailability === "deleted" ? "The original was deleted from the library. The job receipt is retained." : "The result is unavailable. Refresh saved jobs before saving it."}</p>}
        </article>;
      })}
    </section>
  </>;
}
