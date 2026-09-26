"use client";
/* eslint-disable @next/next/no-img-element -- Private originals require same-origin authenticated requests. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw, X } from "lucide-react";
import { useDraft } from "@/lib/useDraft";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import { libraryInput } from "@/lib/genLibrary";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import { draftRequest, writeDraft } from "@/lib/workbench/draft-request";
import type { Asset, Project } from "@/lib/workbench/studio";
import {
  CONNECTED_OUTPUT_TYPES,
  CatalogueError,
  effectiveParameters,
  isStandaloneModel,
  mediaKindForRole,
  modelVoiceParameters,
  validateGenerationRequest,
  type ConnectedModel,
  type ConnectedOutputType,
  type ConnectedParameter,
  type ConnectedUnlim,
} from "@/lib/higgsfield-consumer/catalogue";
import { consumerGenerationInputSchema, type ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import {
  CONNECTED_GENERATION_ENDPOINT,
  CONNECTED_PREFLIGHT_CODES,
  connectedOriginal,
  connectedQuoteRequest,
  connectedRecoverable,
  connectedStatusRequest,
  connectedSubmitRequest,
  parseConnectedJob,
  type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import { CONNECTED_TOOLS, connectedToolModels, connectedToolResultName, connectedToolRoles, findConnectedTool, validateToolRequest, type ConnectedToolName } from "@/lib/higgsfield-consumer/tools";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import { VOICE_TOOLS, findVoiceTool, type ConnectedVoices, type VoiceToolName } from "@/lib/higgsfield-consumer/voice-tools";
import { AtomikVoiceTools, parseVoiceJob, voiceEndpoint, type VoiceCapabilities, type VoiceToolsHandle } from "./AtomikVoiceTools";
import type { ExplainerPreset } from "@/lib/higgsfield-consumer/explainer-presets";
import { awaitingReconciliation, setAsideUnconfirmed, SET_ASIDE_LABEL } from "@/lib/higgsfield-consumer/job-state";
import styles from "./atomik-generate.module.css";

const endpoint = CONNECTED_GENERATION_ENDPOINT;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const WORKFLOW_LABELS: Record<ConnectedOutputType, string> = { image: "Image", video: "Video", audio: "Sound", "3d": "3D" };
type ParameterValue = string | number | boolean | string[];
type StoredAsset = { id: string; origin: "upload" | "generation"; kind: "image" | "video" | "audio"; name: string; url: string };
type Creative = { type: ConnectedOutputType; tool: ConnectedToolName | ""; voice: VoiceToolName | ""; model: string; prompt: string; parameters: Record<string, ParameterValue>; medias: { role: string; asset: StoredAsset }[] };
const empty: Creative = { type: "image", tool: "", voice: "", model: "", prompt: "", parameters: {}, medias: [] };
type Catalogue = { models: ConnectedModel[]; unlim: ConnectedUnlim; complete: boolean; fetchedAt: number };
type Job = ConnectedJob;
type Capability = { owner: boolean; connected: boolean; suspended: boolean };
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = CONNECTED_PREFLIGHT_CODES;
const recoverable = connectedRecoverable;
const retain = (jobs: Job[], attempted: string[]) => {
  const pin = (job: Job) => recoverable(job) || (job.status === "quoted" && attempted.includes(job.id));
  return [...jobs.filter(pin), ...jobs.filter((job) => !pin(job))].slice(0, 25);
};
function storedAsset(value: unknown): StoredAsset | null {
  if (!record(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id) ||
      !["upload", "generation"].includes(String(value.origin)) || !["image", "video", "audio"].includes(String(value.kind))) return null;
  const origin = value.origin as StoredAsset["origin"];
  return { id: value.id, origin, kind: value.kind as StoredAsset["kind"], name: typeof value.name === "string" ? value.name.slice(0, 160) : "Saved original",
    url: `/api/${origin === "upload" ? "uploads" : "media"}/${encodeURIComponent(value.id)}` };
}
function creative(value: unknown): Creative {
  if (!record(value)) return empty;
  const medias = Array.isArray(value.medias) ? value.medias.flatMap((item) => {
    if (!record(item) || typeof item.role !== "string") return [];
    const asset = storedAsset(item.asset);
    return asset ? [{ role: item.role, asset }] : [];
  }) : [];
  return {
    type: CONNECTED_OUTPUT_TYPES.includes(value.type as ConnectedOutputType) ? (value.type as ConnectedOutputType) : "image",
    tool: findConnectedTool(String(value.tool ?? ""))?.name ?? "",
    voice: findVoiceTool(String(value.voice ?? ""))?.name ?? "",
    model: typeof value.model === "string" ? value.model.slice(0, 80) : "",
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 5000) : "",
    parameters: record(value.parameters) ? Object.fromEntries(Object.entries(value.parameters).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v)).slice(0, 64)) as Record<string, ParameterValue> : {},
    medias: medias.slice(0, 30),
  };
}
const identity = (asset: StoredAsset) => (asset.origin === "upload" ? { uploadId: asset.id } : { genId: asset.id });
const parseJob = parseConnectedJob;
const ASSET_KIND: Record<ConnectedOutputType, Asset["kind"]> = { image: "image", video: "video", audio: "audio", "3d": "document" };
/** Only the service's collected local original can become a project asset. */
function originalAsset(job: Job): (Asset & { mime: string }) | null {
  const original = connectedOriginal(job);
  if (!original) return null;
  const tool = job.tool ? findConnectedTool(job.tool.name) : null;
  const sourceName = tool ? job.sources.find((source) => source.kind === tool.sourceKind)?.name ?? "Source" : "";
  return { id: original.generationId, generationId: original.generationId, url: original.url, kind: ASSET_KIND[job.model.outputType], mime: original.mime,
    name: tool ? connectedToolResultName(tool, sourceName) : `${job.model.name} · ${job.input.prompt.slice(0, 80) || WORKFLOW_LABELS[job.model.outputType]}`, category: tool ? "Tools" : "Generate",
    description: `${jobLabel(job)} · ${job.model.name} · ${job.quoteCredits} connected credits`, prompt: job.input.prompt,
    status: "Draft", version: 1, locked: false, refs: [] };
}
/** "Upscale image" for a tool job, otherwise the workflow name. */
const jobLabel = (job: Pick<Job, "tool" | "model">) => job.tool?.label ?? WORKFLOW_LABELS[job.model.outputType];
function ParameterField({ spec, value, onChange, disabled }: { spec: ConnectedParameter; value: ParameterValue | undefined; onChange: (next: ParameterValue | undefined) => void; disabled: boolean }) {
  const label = spec.name.replace(/_/g, " ");
  const hint = [spec.description, spec.required ? "Required" : spec.default !== undefined && spec.default !== null ? `Default ${String(spec.default)}` : ""].filter(Boolean).join(" · ");
  if (spec.type === "bool")
    return <label className={styles.checkbox}><input type="checkbox" aria-label={label} disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked ? true : spec.required ? false : undefined)} /><span>{label}{hint && <small> · {hint}</small>}</span></label>;
  if (spec.options)
    return <label>{label}<select aria-label={label} disabled={disabled} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : spec.type === "number" ? Number(e.target.value) : e.target.value)}>
      {!spec.required && <option value="">Model default</option>}
      {spec.options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select>{hint && <small>{hint}</small>}</label>;
  if (spec.type === "number")
    return <label>{label}<input type="number" aria-label={label} disabled={disabled} min={spec.min} max={spec.max} step="any" value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />{hint && <small>{hint}</small>}</label>;
  if (spec.type === "string_array")
    return <label>{label}<input type="text" aria-label={label} disabled={disabled} value={Array.isArray(value) ? value.join(", ") : ""} placeholder="Comma-separated values" onChange={(e) => { const items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); onChange(items.length ? items : undefined); }} />{hint && <small>{hint}</small>}</label>;
  return <label>{label}<input type="text" aria-label={label} disabled={disabled} maxLength={2000} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />{hint && <small>{hint}</small>}</label>;
}

/** The connected account's voices (cached `list_voices`) for a model that
 * declares the `voice_type` + `voice_id` pair; choosing one sets both. */
function VoicePicker({ kinds, required, voices, error, disabled, type, id, onChange, onRefresh }: {
  kinds: ("preset" | "element")[]; required: boolean; voices: ConnectedVoices | null; error: string; disabled: boolean; type: string; id: string;
  onChange: (next: { type: "preset" | "element"; id: string } | null) => void; onRefresh: () => void;
}) {
  /* Preset voices only: voices made on the account stay there (standalone rule). */
  const usable = voices?.voices.filter((voice) => voice.type === "preset" && kinds.includes(voice.type)) ?? [];
  const value = type && id ? `${type}:${id}` : "";
  const known = !value || usable.some((voice) => `${voice.type}:${voice.id}` === value);
  return <div className={styles.settings} role="group" aria-label="Voice">
    <label>Voice<select aria-label="Voice" disabled={disabled || !voices} value={known ? value : ""} onChange={(e) => { const [kind, ...rest] = e.target.value.split(":"); const voice = usable.find((v) => v.type === kind && v.id === rest.join(":")); onChange(voice ? { type: voice.type, id: voice.id } : null); }}>
      <option value="">{voices ? (required ? "Choose a voice" : "Model default voice") : error ? "Voices unavailable" : "Reading voices…"}</option>
      {usable.length > 0 && <optgroup label="Preset voices">{usable.map((voice) => <option key={`preset:${voice.id}`} value={`preset:${voice.id}`}>{voice.name}{voice.language ? ` · ${voice.language}` : ""}</option>)}</optgroup>}
    </select><small>{error || (voices ? `${usable.length} voices${voices.complete ? "" : " (partial listing)"} · read ${new Date(voices.fetchedAt).toLocaleTimeString()}${required ? " · Required" : ""}` : "The connected account’s voices are read once an hour.")}</small></label>
    <button type="button" className="suite-button" disabled={disabled} onClick={onRefresh}><RefreshCw size={14} />Reload voices</button>
  </div>;
}

type Explainer = { presets: ExplainerPreset[]; fetchedAt: number; catalogueModels: string[] };
/** Read-only explainer / faceless-video styles (slice F6). Generation is not
 * wired: there is no catalogue-declared, priced explainer job to quote. */
function ExplainerStyles({ load, disabled }: { load: (refresh: boolean) => Promise<Explainer>; disabled: boolean }) {
  const [value, setValue] = useState<Explainer | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const read = async (refresh: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { setValue(await load(refresh)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The explainer styles could not be read."); } finally { setBusy(false); }
  };
  return <section className="suite-panel" aria-label="Explainer styles">
    <div className="suite-section-heading"><div><h2>Explainer styles</h2><p>Styles the connected account offers for narrated explainer and faceless videos.</p></div><span className="suite-badge">Not runnable yet</span></div>
    <p className={styles.hint} role="status">{value?.catalogueModels.length ? "The connected catalogue lists an explainer model, but explainer generation is not wired here yet." : "Browsing only: the connected catalogue lists no explainer model to quote, so nothing here can be priced or generated."}</p>
    <div className={styles.actions}><button type="button" className="suite-button" disabled={disabled || busy} onClick={() => void read(!!value)}><RefreshCw size={14} />{busy ? "Reading styles…" : value ? "Reload explainer styles" : "Load explainer styles"}</button></div>
    {value && <><small className={styles.hint}>{value.presets.length.toLocaleString("en-US")} styles · read {new Date(value.fetchedAt).toLocaleTimeString()}</small>
      <ul className={styles.explainers} aria-label="Explainer style list">{value.presets.map((preset) => <li key={preset.id}><span>{preset.title}</span>{preset.aspect && <small>{preset.aspect}</small>}</li>)}</ul></>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}

/** Catalogue-driven generation on the workspace owner's connected account.
 * Opening only reads local records; the catalogue, quotes and status checks are explicit. */
export function AtomikGenerate({ project, scope, refreshProject, onInput }: {
  project: Project; scope: string; refreshProject: () => Promise<void>;
  /** The exact quote input this form would send whenever it could send it, else null (a host's Atomik plan prices the same request). */
  onInput?: (input: ConsumerGenerationInput | null) => void;
}) {
  const request = useScopedFetch(scope);
  const draftId = project.id;
  const draft = useDraft<Creative>(`atomik-generate:${project.id}`, empty), input = creative(draft.value);
  const attemptKey = `particl-consumer-generation:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}:attempts`;
  const [capability, setCapability] = useState<Capability | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]), [selectedId, setSelectedId] = useState(""), [attempts, setAttempts] = useState<string[]>([]);
  const [approved, setApproved] = useState(false), [disclosed, setDisclosed] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [search, setSearch] = useState(""), [activeRole, setActiveRole] = useState("");
  const [clock, setClock] = useState(() => Date.now()), [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const pending = useRef(false), live = useRef(false), lifecycle = useRef(0), attemptIds = useRef<string[]>([]);
  const voiceRef = useRef<VoiceToolsHandle>(null);
  const [voiceCapabilities, setVoiceCapabilities] = useState<VoiceCapabilities | null>(null);
  const [voiceJobs, setVoiceJobs] = useState<Parameters<typeof AtomikVoiceTools>[0]["jobs"]>([]), [voiceRevision, setVoiceRevision] = useState(0);
  const voiceTool = findVoiceTool(input.voice);
  const tool = voiceTool ? null : findConnectedTool(input.tool);
  // Game-pipeline-only models are never offered, even if a listing carries them.
  const models = !catalogue ? [] : tool ? connectedToolModels(tool, catalogue) : catalogue.models.filter((m) => m.outputType === input.type && isStandaloneModel(m));
  const model = models.find((m) => m.id === input.model && m.outputType === input.type) ?? null;
  const voiceSpec = model && !tool ? modelVoiceParameters(model) : null;
  // A voice-taking model gets the voice picker in place of two free-text settings.
  const specs = model ? effectiveParameters(model).filter((spec) => !voiceSpec || (spec.name !== "voice_type" && spec.name !== "voice_id")) : [];
  const [voices, setVoices] = useState<ConnectedVoices | null>(null), [voicesError, setVoicesError] = useState("");
  const toolRoles = tool && model ? (() => { try { return connectedToolRoles(tool, model); } catch { return null; } })() : null;
  const roles = toolRoles ? [toolRoles.source, ...toolRoles.extras.map((extra) => extra.role)] : model ? [...new Set(model.medias.flatMap((slot) => slot.roles))] : [];
  const role = roles.includes(activeRole) ? activeRole : roles[0] ?? "";
  const normalized: ConsumerGenerationInput = { type: input.type, model: input.model, prompt: tool ? "" : input.prompt, parameters: input.parameters, medias: input.medias.map((m) => ({ role: m.role, source: identity(m.asset) })), ...(tool ? { tool: { name: tool.name, model: input.model } } : {}) };
  let validation = "";
  if (model) {
    try {
      const request = { ...normalized, medias: input.medias.map((m) => ({ role: m.role, kind: mediaKindForRole(m.role) })) };
      if (!consumerGenerationInputSchema.safeParse(normalized).success) validation = "Review the prompt, settings and reference files.";
      else if (tool) validateToolRequest(tool, model, request);
      else validateGenerationRequest(model, request);
    } catch (cause) { validation = cause instanceof CatalogueError ? cause.message : "Review the generation settings."; }
  } else validation = tool ? `Choose a model for ${tool.label}.` : "Choose a model from the connected catalogue.";
  const selected = jobs.find((job) => job.id === selectedId);
  const matches = !!selected && JSON.stringify(selected.input) === JSON.stringify(normalized);
  const missing = attempts.filter((id) => !jobs.some((job) => job.id === id));
  const unresolved = missing.length > 0 || jobs.some((job) => awaitingReconciliation(job) || (job.status === "quoted" && attempts.includes(job.id)));
  const ready = !!capability?.owner && capability.connected && !capability.suspended && !busy;
  const canQuote = ready && !validation && !unresolved && (!input.medias.length || disclosed);
  const offerable = !!capability?.owner && capability.connected && !capability.suspended && !validation && !unresolved && (!input.medias.length || disclosed);
  const offeredKey = offerable ? JSON.stringify(consumerGenerationInputSchema.parse(normalized)) : "null";
  const report = useRef(onInput);
  useEffect(() => { report.current = onInput; }, [onInput]);
  useEffect(() => { report.current?.(offeredKey === "null" ? null : (JSON.parse(offeredKey) as ConsumerGenerationInput)); }, [offeredKey]);
  useEffect(() => () => report.current?.(null), []);
  const canSubmit = ready && selected?.status === "quoted" && matches && approved && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  const change = (patch: Partial<Creative>) => { draft.set((before) => ({ ...creative(before), ...patch })); setApproved(false); setNotice(""); };
  const confirmAttempts = useCallback((confirmed: Job[]) => {
    const byId = new Map(confirmed.map((job) => [job.id, job]));
    const next = attemptIds.current.filter((id) => { const job = byId.get(id); return !job || awaitingReconciliation(job) || (job.status === "quoted" && job.quoteExpired !== true); });
    try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep the guard when its resolution cannot be saved. */ }
  }, [attemptKey]);
  const saveJob = (job: Job) => { setJobs((before) => retain([job, ...before.filter((item) => item.id !== job.id)], attemptIds.current)); setSelectedId(job.id); };
  const json = useCallback(async (url: string, init?: RequestInit) => {
    const response = await request(url, { cache: "no-store", ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !record(result)) throw new RequestError(typeof result?.error === "string" ? result.error : "The request could not be completed. Refresh saved jobs before continuing.", response.status, typeof result?.code === "string" ? result.code : undefined);
    return result;
  }, [request]);
  const post = useCallback((body: Record<string, unknown>) => json(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [json]);
  const voicesPending = useRef(false);
  const loadVoices = useCallback(async (refresh = false) => {
    if (voicesPending.current) return;
    const token = lifecycle.current; voicesPending.current = true; setVoicesError("");
    try {
      const result = await json(voiceEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "voices", ...(refresh ? { refresh: true } : {}) }) });
      if (!live.current || lifecycle.current !== token) return;
      const value = result.voices;
      if (!record(value) || !Array.isArray(value.voices) || value.voices.length > 500) throw new Error("The connected account’s voices could not be read.");
      const list = value.voices.flatMap((item) => record(item) && typeof item.id === "string" && item.id.length <= 200 && (item.type === "preset" || item.type === "element") && typeof item.name === "string"
        ? [{ id: item.id, type: item.type as "preset" | "element", name: item.name.slice(0, 160), ...(typeof item.language === "string" ? { language: item.language.slice(0, 60) } : {}) }] : []);
      setVoices({ voices: list, complete: value.complete !== false, fetchedAt: Number(value.fetchedAt) || Date.now() });
    } catch (reason) { if (live.current && lifecycle.current === token) setVoicesError(reason instanceof Error ? reason.message : "The connected account’s voices could not be read."); }
    finally { if (lifecycle.current === token) voicesPending.current = false; }
  }, [json]);
  // Voices are read only when a voice-taking model is chosen (cached an hour server-side).
  const wantsVoices = !!voiceSpec && !voices && !voicesError && !!capability?.owner && capability.connected;
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (wantsVoices) void loadVoices(); }, [wantsVoices, loadVoices]);
  const parseCatalogue = (value: unknown): Catalogue => {
    if (!record(value) || !Array.isArray(value.models) || value.models.length > 400 || !record(value.unlim)) throw new Error("The connected catalogue could not be read.");
    return { models: value.models as ConnectedModel[], unlim: { available: value.unlim.available === true, remaining: typeof value.unlim.remaining === "number" ? value.unlim.remaining : null, expiresAt: typeof value.unlim.expiresAt === "string" ? value.unlim.expiresAt : null }, complete: value.complete !== false, fetchedAt: Number(value.fetchedAt) || Date.now() };
  };
  const refresh = useCallback(async (withCatalogue = false, refreshCatalogue = false) => {
    if (pending.current) return;
    const token = lifecycle.current;
    pending.current = true; setBusy("refresh"); setError("");
    try {
      const me = await json("/api/me");
      if (!live.current || lifecycle.current !== token) return;
      if (typeof me.id !== "string" || !record(me.workspace) || typeof me.workspace.id !== "string" || workbenchScopeFor(me.workspace.id, me.id) !== scope)
        throw new Error("Your account or workspace changed. Reload this project before continuing.");
      if (me.owner !== true) { setCapability({ owner: false, connected: false, suspended: false }); setJobs([]); return; }
      const [connection, result, voice] = await Promise.all([json("/api/higgsfield/consumer/connection"), json(`${endpoint}?${new URLSearchParams({ draftId })}`), json(`${voiceEndpoint}?${new URLSearchParams({ draftId })}`).catch(() => null)]);
      if (!live.current || lifecycle.current !== token) return;
      if (!Array.isArray(result.jobs) || result.jobs.length > 25) throw new Error("Saved generation jobs could not be loaded.");
      const saved = result.jobs.map((job) => parseJob(job, draftId));
      confirmAttempts(saved);
      setJobs(retain(saved, attemptIds.current));
      // Voice tools are read independently: an unavailable or unreadable voice
      // listing disables that group only, never the workflows or Tools.
      let voiceReady = false;
      if (voice && Array.isArray(voice.jobs) && voice.jobs.length <= 25 && record(voice.capabilities)) {
        try {
          const caps = voice.capabilities;
          const languages = Array.isArray(caps.languages) ? caps.languages.flatMap((entry) => record(entry) && typeof entry.code === "string" && typeof entry.name === "string" ? [{ code: entry.code.slice(0, 8), name: entry.name.slice(0, 40) }] : []).slice(0, 64) : [];
          setVoiceJobs(voice.jobs.map((job) => parseVoiceJob(job, draftId)));
          setVoiceCapabilities({ voice: caps.voice === true, dubbing: caps.dubbing === true, analysis: caps.analysis === true, reframe: caps.reframe === true, languages });
          voiceReady = true;
        } catch { /* Fall through to the disabled voice group below. */ }
      }
      if (!voiceReady) { setVoiceJobs([]); setVoiceCapabilities({ voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }); }
      setVoiceRevision((before) => before + 1);
      const connected = connection.connected === true && connection.requiresReconnect !== true;
      setCapability({ owner: true, connected, suspended: me.workspace.suspended === true });
      setClock(Date.now());
      if (withCatalogue && connected) {
        const listing = await post({ action: "catalogue", ...(refreshCatalogue ? { refresh: true } : {}) });
        if (!live.current || lifecycle.current !== token) return;
        setCatalogue(parseCatalogue(listing.catalogue));
      }
    } catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "Saved generation jobs could not be loaded."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [json, post, scope, draftId, confirmAttempts]);
  useEffect(() => {
    live.current = true;
    try { const values = JSON.parse(localStorage.getItem(attemptKey) ?? "[]"); attemptIds.current = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string" && uuid.test(v)).slice(-100) : []; setAttempts(attemptIds.current); } catch { /* A later submit requires writable recovery storage. */ }
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [attemptKey, refresh]);
  useEffect(() => { if (!jobs.length) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [jobs.length]);
  async function act(action: "quote" | "submit" | "status", job: Job | null | undefined = selected, missingId?: string) {
    if (pending.current || !capability?.owner) return;
    if (action === "quote" && !canQuote) return;
    if (action === "submit" && (!canSubmit || !job || job.id !== selectedId)) return;
    const recovering = action === "status" && job === null && !!missingId && missing.includes(missingId);
    if (action === "status" && !recovering && (!job || !(job.status === "accepted" || (job.status === "uncertain" && job.providerReceipt)) || clock < (nextPoll[job.id] ?? 0))) return;
    const token = lifecycle.current;
    pending.current = true; setBusy(action); setError(""); setNotice("");
    try {
      if (action === "submit") {
        const next = [...new Set([...attemptIds.current, job!.id])].slice(-100);
        try { localStorage.setItem(attemptKey, JSON.stringify(next)); } catch { throw new Error("Submission recovery could not be saved in this browser. Enable local storage before generating."); }
        attemptIds.current = next; setAttempts(next); setApproved(false);
      }
      const body: Record<string, unknown> = action === "quote" ? connectedQuoteRequest(draftId, normalized)
        : action === "submit" ? connectedSubmitRequest(draftId, job!)
        : connectedStatusRequest(draftId, job?.id ?? missingId!);
      const result = await post(body);
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseJob(result.job, draftId); confirmAttempts([saved]); saveJob(saved);
      if (action === "quote") setNotice("Review the model, settings, wallet and exact price below before generating.");
      if (action === "submit") setNotice("Request recorded. Use Check result to recover its progress.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll((before) => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        setNotice(saved.status === "completed" ? (originalAsset(saved) ? "The original is ready to save to this project." : "The generation completed, but its original is unavailable. Refresh saved jobs before saving it.") : saved.status === "failed" ? (record(result.collection) && typeof result.collection.message === "string" ? result.collection.message.slice(0, 200) : "The connected account reported that this generation failed.") : "Status checked. The saved job remains available here.");
      }
    } catch (reason) {
      if (live.current && lifecycle.current === token) {
        if (action === "submit" && job && reason instanceof RequestError && ([400, 423, 429].includes(reason.status) || (!!reason.code && preflightCodes.has(reason.code)))) {
          const next = attemptIds.current.filter((id) => id !== job.id);
          try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep recovery guarded if storage fails. */ }
          setSelectedId(""); setApproved(false);
        }
        setError(reason instanceof Error ? reason.message : "The request could not be completed. Refresh saved jobs before continuing.");
      }
    } finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  async function addReference(payload: Parameters<typeof resolveGenInput>[0]) {
    if (voiceTool) {
      if (pending.current) return;
      const token = lifecycle.current; pending.current = true; setBusy("reference"); setError("");
      try {
        const asset: GenInputAsset = await resolveGenInput(payload, scope);
        if (!live.current || lifecycle.current !== token) return;
        voiceRef.current?.addSource(asset);
      } catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "This file cannot be used as the source."); }
      finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
      return;
    }
    if (pending.current || !model || !role) { setError(model ? "Choose a reference role first." : "Choose a model before adding reference files."); return; }
    const token = lifecycle.current; pending.current = true; setBusy("reference"); setError("");
    try {
      const asset: GenInputAsset = await resolveGenInput(payload, scope);
      if (!live.current || lifecycle.current !== token) return;
      const kind = mediaKindForRole(role);
      if (asset.kind !== kind) throw new Error(tool ? `${tool.label} needs ${kind === "image" ? "an image" : `a ${kind}`} file.` : `The role “${role}” needs a ${kind} file.`);
      if (asset.bytes > 50 * 1024 * 1024) throw new Error("Each reference file must be no larger than 50 MB.");
      if (input.medias.some((m) => m.asset.id === asset.id && m.asset.origin === asset.origin)) throw new Error("This file is already a reference.");
      const slot = model.medias.find((s) => s.roles.includes(role));
      const used = input.medias.filter((m) => slot?.roles.includes(m.role)).length;
      if (slot?.max !== undefined && used >= slot.max) throw new Error(`${model.name} accepts at most ${slot.max} reference file${slot.max === 1 ? "" : "s"}.`);
      const entry = { role, asset: { id: asset.id, origin: asset.origin, kind: asset.kind as StoredAsset["kind"], name: asset.name, url: asset.url } };
      // A tool takes exactly one file per role: choosing another replaces it.
      change({ medias: tool ? [...input.medias.filter((m) => m.role !== role), entry] : [...input.medias, entry] });
    } catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "This file cannot be used as a reference."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  async function save(job: Job, asset: Asset) {
    if (pending.current) return;
    const token = lifecycle.current; pending.current = true; setBusy("save"); setError("");
    try {
      const latest = await draftRequest<{ project: Project | null; revision: number }>(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, scope);
      if (!live.current || token !== lifecycle.current) return;
      if (latest.project?.id !== project.id || latest.project.productionProjectId !== project.productionProjectId) throw new Error("The selected project changed. Reload before saving.");
      if (!latest.project.assets.some((item) => item.generationId === asset.generationId))
        await writeDraft("/api/workbench", scope, { project: { ...latest.project, assets: [...latest.project.assets, asset] }, revision: latest.revision });
      if (!live.current || token !== lifecycle.current) return;
      await refreshProject();
      if (live.current && token === lifecycle.current) setNotice("Original saved to the project library.");
    } catch (reason) { if (live.current && token === lifecycle.current) setError(reason instanceof Error ? reason.message : "The original could not be saved in this project."); }
    finally { if (token === lifecycle.current) { pending.current = false; if (live.current) setBusy(""); } }
  }
  const unlimited = (m: ConnectedModel) => m.supportsUnlim && catalogue?.unlim.available === true;
  const pickTool = (next: ConnectedToolName) => { const preset = findConnectedTool(next)!; const first = catalogue ? connectedToolModels(preset, catalogue)[0] : undefined; change({ tool: next, voice: "", type: preset.outputType, model: first?.id ?? "", prompt: "", parameters: {}, medias: [] }); setActiveRole(""); };
  const typedTools = VOICE_TOOLS.filter((preset) => voiceCapabilities?.[preset.name === "voice_change" ? "voice" : preset.name === "dubbing" ? "dubbing" : preset.name === "reframe" ? "reframe" : "analysis"] === true);
  const voiceTools = typedTools.filter((preset) => preset.group === "voice");
  // Typed connected-account tools that transform a video (Reframe) sit with the Tools presets.
  const typedToolPresets = typedTools.filter((preset) => preset.group === "tools");
  const pickTyped = (name: VoiceToolName) => { change({ voice: name, tool: "", model: "", prompt: "", parameters: {}, medias: [] }); setActiveRole(""); };
  const settingsSummary = (job: Job) => Object.entries(job.input.parameters).map(([k, v]) => `${k.replace(/_/g, " ")} ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ");
  return <div className={styles.workspace}>
    <div className={styles.columns}>
      <section className={`suite-panel ${styles.creator}`} aria-label="Generate on the connected account">
        <div className="suite-section-heading"><div><h2>Generate</h2><p>Image, video, sound and 3D workflows from the connected account’s catalogue, tools that transform a project file, and voice tools that revoice or dub a project video. Every run is quoted in connected credits and approved before it is submitted.</p></div><span className="suite-badge">Connected account</span></div>
        {capability?.owner === false ? <p className="suite-footnote">The workspace owner can use the connected account. Your Particl generation tools remain available in Runs.</p> : <>
          {capability && !capability.connected && <p className="suite-footnote">Connect or reconnect the owner’s account in <a href="/settings#engines">Workspace settings <ArrowUpRight size={12} /></a>.</p>}
          {capability?.suspended && <p role="status">Rendering is paused for this workspace. Saved jobs can still be reviewed.</p>}
          <fieldset className={styles.form} disabled={!capability?.owner || !!busy}>
            <div className={styles.groups}>
              <span className={styles.hint}>Workflows</span>
              <div role="group" aria-label="Generate workflow" className={styles.workflows}>
                {CONNECTED_OUTPUT_TYPES.map((type) => <button key={type} type="button" aria-pressed={!tool && !voiceTool && input.type === type} onClick={() => { change({ type, tool: "", voice: "", model: "", parameters: {}, medias: [] }); setActiveRole(""); }}>{WORKFLOW_LABELS[type]}</button>)}
              </div>
              <span className={styles.hint}>Tools</span>
              <div role="group" aria-label="Tools" className={styles.workflows}>
                {CONNECTED_TOOLS.map((preset) => <button key={preset.name} type="button" aria-pressed={tool?.name === preset.name} onClick={() => pickTool(preset.name)}>{preset.label}</button>)}
                {typedToolPresets.map((preset) => <button key={preset.name} type="button" aria-pressed={voiceTool?.name === preset.name} onClick={() => pickTyped(preset.name)}>{preset.label}</button>)}
              </div>
              {voiceTools.length > 0 && <span className={styles.hint}>Voice</span>}
              {voiceTools.length > 0 && <div role="group" aria-label="Voice tools" className={styles.workflows}>
                {voiceTools.map((preset) => <button key={preset.name} type="button" aria-pressed={voiceTool?.name === preset.name} onClick={() => pickTyped(preset.name)}>{preset.label}</button>)}
              </div>}
            </div>
            {voiceTool ? null : !catalogue ? <p className={styles.hint}>{busy === "refresh" ? "Reading the connected catalogue…" : "The connected catalogue is not loaded. Refresh to read it."}</p> : <>
              {tool && <p className={styles.hint} aria-label="Selected tool">{tool.label}: {tool.description} Needs one {tool.sourceKind}{tool.extraKinds.map((kind) => ` and one ${kind} file`).join("")} from this project; no prompt.</p>}
              <label>Model<select aria-label="Generate model" value={model?.id ?? ""} onChange={(e) => { change({ model: e.target.value, parameters: {}, medias: [] }); setActiveRole(""); }}>
                <option value="">Choose a {tool ? `model for ${tool.label}` : `${WORKFLOW_LABELS[input.type].toLowerCase()} model`}</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}{unlimited(m) ? " · unlimited-eligible" : ""}</option>)}
              </select><small className={styles.hint}>{models.length} {tool ? `models for ${tool.label}` : `${WORKFLOW_LABELS[input.type].toLowerCase()} models`}{catalogue.complete ? "" : " (partial listing)"} · read {new Date(catalogue.fetchedAt).toLocaleTimeString()}</small></label>
              {model && <div className={styles.model} aria-label="Selected model">
                <strong>{model.name} {unlimited(model) && <span className={styles.badge}>Unlimited-eligible</span>}</strong>
                {model.description && <span>{model.description}</span>}
                <dl>
                  {model.aspectRatios.length > 0 && <><dt>Aspect ratios</dt><dd>{model.aspectRatios.join(" · ")}</dd></>}
                  {(model.durations?.length || model.durationRange || specs.some((s) => s.name === "duration")) && <><dt>Duration</dt><dd>{model.durations?.length ? `${model.durations.join(" / ")} s` : model.durationRange ? `${model.durationRange.min}–${model.durationRange.max} s` : (() => { const d = specs.find((s) => s.name === "duration"); return d?.options ? `${d.options.join(" / ")} s` : d?.min !== undefined || d?.max !== undefined ? `${d?.min ?? "?"}–${d?.max ?? "?"} s` : "Model default"; })()}</dd></>}
                  <dt>Reference files</dt><dd>{model.medias.length ? model.medias.map((slot) => `${slot.roles.join(", ")}${slot.max !== undefined ? ` (up to ${slot.max})` : ""}${slot.required ? " · required" : ""}`).join(" · ") : "None"}</dd>
                </dl>
              </div>}
            </>}
            {!tool && !voiceTool && <label>Prompt<textarea aria-label="Generate prompt" rows={5} maxLength={5000} value={input.prompt} onChange={(e) => change({ prompt: e.target.value })} /><small className={styles.hint}>{input.prompt.length}/5000</small></label>}
            {!voiceTool && voiceSpec && <VoicePicker kinds={voiceSpec.kinds} required={voiceSpec.required} voices={voices} error={voicesError} disabled={!!busy}
              type={typeof input.parameters.voice_type === "string" ? input.parameters.voice_type : ""} id={typeof input.parameters.voice_id === "string" ? input.parameters.voice_id : ""}
              onRefresh={() => void loadVoices(true)}
              onChange={(next) => { const parameters = { ...input.parameters }; delete parameters.voice_type; delete parameters.voice_id; if (next) { parameters.voice_type = next.type; parameters.voice_id = next.id; } change({ parameters }); }} />}
            {!voiceTool && specs.length > 0 && <div className={styles.settings} role="group" aria-label="Model settings">
              {specs.map((spec) => <ParameterField key={spec.name} spec={spec} value={input.parameters[spec.name]} disabled={!!busy} onChange={(next) => { const parameters = { ...input.parameters }; if (next === undefined) delete parameters[spec.name]; else parameters[spec.name] = next; change({ parameters }); }} />)}
            </div>}
            {!voiceTool && model && roles.length > 0 && <div className={styles.references} role="group" aria-label={tool ? "Source files" : "Reference files"}>
              <span className={styles.hint}>{tool ? `Pick the ${tool.sourceKind}${tool.extraKinds.length ? ` and ${tool.extraKinds.join(", ")}` : ""} this tool works on from the library. Source files are copied to the connected account when a quote is requested.` : "Choose a role, then pick a project file from the library. Reference files are copied to the connected account when a quote is requested."}</span>
              <div className={styles.chips} role="group" aria-label={tool ? "Source role" : "Reference role"}>{roles.map((r) => <button key={r} type="button" aria-pressed={role === r} onClick={() => setActiveRole(r)}>{tool ? `${mediaKindForRole(r)} source` : `${r.replace(/_/g, " ")} · ${mediaKindForRole(r)}`}</button>)}</div>
              {input.medias.map((m, index) => <div key={`${m.asset.origin}:${m.asset.id}`} className={styles.reference}>
                {m.asset.kind === "image" ? <img src={m.asset.url} alt="" /> : m.asset.kind === "video" ? <video src={m.asset.url} muted playsInline preload="metadata" /> : <span aria-hidden="true">♪</span>}
                <span>{m.asset.name}</span>
                <select aria-label={`Role for ${m.asset.name}`} value={m.role} onChange={(e) => { const medias = input.medias.map((item, i) => (i === index ? { ...item, role: e.target.value } : item)); change({ medias }); }}>
                  {roles.filter((r) => mediaKindForRole(r) === m.asset.kind).map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </select>
                <button type="button" aria-label={`Remove ${m.asset.name}`} onClick={() => change({ medias: input.medias.filter((_, i) => i !== index) })}><X size={14} /></button>
              </div>)}
              {input.medias.length > 0 && <label className={styles.checkbox}><input type="checkbox" checked={disclosed} onChange={(e) => setDisclosed(e.target.checked)} />I understand these project originals are copied to the connected account to prepare the quote.</label>}
            </div>}
          </fieldset>
          {voiceTool && capability && <AtomikVoiceTools ref={voiceRef} project={project} scope={scope} tool={voiceTool.name} capability={capability} capabilities={voiceCapabilities} jobs={voiceJobs} revision={voiceRevision} refreshProject={refreshProject} />}
          {!voiceTool && validation && model && <p className={styles.hint} role="status">{validation}</p>}
          {!voiceTool && <div className={styles.actions}>
            <button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : "Get connected-credit quote"}</button>
            <button type="button" className="suite-button" disabled={!!busy} onClick={() => void refresh(true)}><RefreshCw size={14} />Refresh saved jobs</button>
            <button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void refresh(true, true)}>Reload catalogue</button>
          </div>}
          {voiceTool && <div className={styles.actions}><button type="button" className="suite-button" disabled={!!busy} onClick={() => void refresh(true)}><RefreshCw size={14} />Refresh saved jobs</button></div>}
          {unresolved && <p role="status" className="suite-footnote">A submission needs reconciliation. It is never sent again: check it below, or set it aside in Workspace › Engines.</p>}
          {!!missing.length && <div className={styles.actions}><p className="suite-footnote">An earlier submission is outside the recent history. Recover its saved record before starting another generation.</p><button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void act("status", null, missing[0])}>Recover earlier submission</button></div>}
          {!voiceTool && selected?.status === "quoted" && <div className={styles.quote} aria-label="Connected-credit quote">
            <strong>{selected.quoteCredits} connected credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
            <small>{jobLabel(selected)} · {selected.model.name}{settingsSummary(selected) ? ` · ${settingsSummary(selected)}` : ""}{selected.input.medias.length ? ` · ${selected.input.medias.length} reference file${selected.input.medias.length === 1 ? "" : "s"}` : ""}</small>
            <p>{matches ? selected.input.prompt || (selected.tool ? selected.sources.map((source) => source.name).join(" + ") || "No prompt." : "No prompt.") : "The prompt, settings or references changed. Request a new quote before generating."}</p>
            <p className="suite-footnote">{selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The connected account’s active wallet is shared across its clients; the wallet and exact price are checked again before submission. Output belongs to the connected account and is billed in its credits.</p>
            <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {selected.quoteCredits} connected credits to {selected.workspaceName} for this generation.</label>
            <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Generate · ${selected.quoteCredits} connected credits`}</button>
          </div>}
        </>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </section>
      <aside className={`suite-panel ${styles.library}`} aria-label="Project library">
        <div className="suite-section-heading"><div><h2>Project library</h2><p>{voiceTool ? `Pick the video for ${voiceTool.label}.` : tool ? `Pick the source file for ${tool.label}.` : "Pick reference files for the selected model."}</p></div></div>
        <label className={styles.search}>Search assets<input aria-label="Search project assets" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <GenAssetLibrary workbenchProjectId={project.id} projectName={project.name} allowWorkspaceBrowse initialBrowseScope="project" search={search} audioReference={!voiceTool && roles.some((r) => mediaKindForRole(r) === "audio")}
          onUseAsset={(asset) => void addReference(asset)} onUseReference={(asset) => void addReference(libraryInput(asset))}
          onUsePrompt={(take) => change({ prompt: take.prompt.slice(0, 5000) })} />
      </aside>
    </div>
    {capability?.owner && <ExplainerStyles disabled={!capability.connected} load={async (refresh) => {
      const result = await post({ action: "explainer-presets", ...(refresh ? { refresh: true } : {}) });
      const value = result.explainer;
      if (!record(value) || !Array.isArray(value.presets) || value.presets.length > 200) throw new Error("The explainer styles could not be read.");
      return { presets: value.presets.flatMap((item) => record(item) && typeof item.id === "string" && typeof item.title === "string" ? [{ id: item.id, title: item.title.slice(0, 120), aspect: item.aspect === "9:16" || item.aspect === "16:9" ? item.aspect : null }] : []),
        fetchedAt: Number(value.fetchedAt) || Date.now(), catalogueModels: Array.isArray(value.catalogueModels) ? value.catalogueModels.filter((id): id is string => typeof id === "string").slice(0, 4) : [] };
    }} />}
    <section className="suite-panel" aria-label="Saved generation jobs">
      <div className="suite-section-heading"><div><h2>Results</h2><p>Saved quotes, submissions and collected originals for this project.</p></div></div>
      {!jobs.length ? <p className="suite-footnote">No saved generation jobs yet.</p> : <div className={styles.jobs}>{jobs.map((job) => {
        const original = originalAsset(job), saved = original && project.assets.some((asset) => asset.generationId === original.generationId);
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}>
          <div><strong>{job.status === "completed" ? (original ? "Original ready" : job.originalAvailability === "deleted" ? "Completed · original deleted" : "Completed · original unavailable") : job.status === "accepted" ? "In progress" : job.status === "quoted" && job.quoteExpired === true ? "Expired quote · no dispatch recorded" : setAsideUnconfirmed(job) ? SET_ASIDE_LABEL : job.status === "uncertain" || job.status === "dispatching" || (attempts.includes(job.id) && job.status === "quoted") ? "Submission needs reconciliation" : job.status === "failed" ? "Generation failed" : "Saved quote"}</strong><span>{job.quoteCredits} connected credits</span></div>
          <p>{job.input.prompt || (job.tool ? job.sources.map((source) => source.name).join(" + ") || "No prompt." : "No prompt.")}</p>
          <small>{jobLabel(job)} · {job.model.name}{settingsSummary(job) ? ` · ${settingsSummary(job)}` : ""} · {job.workspaceName}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { setSelectedId(job.id); setApproved(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || (job.status === "uncertain" && !!job.providerReceipt)) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability?.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved request" : "Check result"}</button>}
          {original && <div className={styles.result}>
            {original.kind === "image" ? <img src={original.url} alt={original.name} /> : original.kind === "video" ? <video src={original.url} controls playsInline preload="metadata" /> : original.kind === "audio" ? <audio src={original.url} controls preload="metadata" /> : <small>3D file · {original.mime === "application/zip" ? "zip archive" : "GLB model"} · download to open in Astra.</small>}
            <div className={styles.actions}><a className="suite-text-button" href={`${original.url}?download=1`} download>Download original</a><button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void save(job, original)}>{saved ? "In project library" : "Save to project"}</button></div>
          </div>}
          {job.status === "completed" && !original && <p className="suite-footnote">{job.originalAvailability === "deleted" ? "The original was deleted from the library. The job receipt is retained." : "The original is unavailable. Refresh saved jobs before saving it."}</p>}
        </article>;
      })}</div>}
    </section>
  </div>;
}
