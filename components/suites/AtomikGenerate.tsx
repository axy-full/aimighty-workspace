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
  mediaKindForRole,
  validateGenerationRequest,
  type ConnectedModel,
  type ConnectedOutputType,
  type ConnectedParameter,
  type ConnectedUnlim,
} from "@/lib/higgsfield-consumer/catalogue";
import { consumerGenerationInputSchema, type ConsumerGenerationInput } from "@/lib/higgsfield-consumer/generation-contract";
import GenAssetLibrary from "@/components/make/GenAssetLibrary";
import styles from "./atomik-generate.module.css";

const endpoint = "/api/higgsfield/consumer/generation";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const WORKFLOW_LABELS: Record<ConnectedOutputType, string> = { image: "Image", video: "Video", audio: "Sound", "3d": "3D" };
type ParameterValue = string | number | boolean | string[];
type StoredAsset = { id: string; origin: "upload" | "generation"; kind: "image" | "video" | "audio"; name: string; url: string };
type Creative = { type: ConnectedOutputType; model: string; prompt: string; parameters: Record<string, ParameterValue>; medias: { role: string; asset: StoredAsset }[] };
const empty: Creative = { type: "image", model: "", prompt: "", parameters: {}, medias: [] };
type Catalogue = { models: ConnectedModel[]; unlim: ConnectedUnlim; complete: boolean; fetchedAt: number };
type Job = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerGenerationInput; model: { id: string; name: string; outputType: ConnectedOutputType };
  workspaceId: string; workspaceName: string; quoteCredits: number; creditUnit: "higgsfield_credits"; quoteExpiresAt: number;
  quoteExpired?: boolean; providerJobId: string | null; result?: unknown; providerReceipt?: unknown;
  originalAvailable?: boolean; originalAvailability?: string; createdAt: number;
};
type Capability = { owner: boolean; connected: boolean; suspended: boolean };
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = new Set(["quote_expired", "quote_changed", "workspace_changed", "unapproved_adjustment", "insufficient_credits", "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed", "connection_busy", "model_unknown", "parameter_invalid", "parameter_unknown"]);
const recoverable = (job: Job) => ["dispatching", "accepted", "uncertain"].includes(job.status);
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
    model: typeof value.model === "string" ? value.model.slice(0, 80) : "",
    prompt: typeof value.prompt === "string" ? value.prompt.slice(0, 5000) : "",
    parameters: record(value.parameters) ? Object.fromEntries(Object.entries(value.parameters).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v)).slice(0, 64)) as Record<string, ParameterValue> : {},
    medias: medias.slice(0, 30),
  };
}
const identity = (asset: StoredAsset) => (asset.origin === "upload" ? { uploadId: asset.id } : { genId: asset.id });
function parseJob(value: unknown, draftId: string): Job {
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
      !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
      typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" || value.workspaceName.length > 200 ||
      value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !Number.isFinite(value.quoteCredits) || value.quoteCredits <= 0 || value.quoteCredits > 100000 ||
      !(value.providerJobId === null || (typeof value.providerJobId === "string" && uuid.test(value.providerJobId))) ||
      typeof value.quoteExpiresAt !== "number" || typeof value.createdAt !== "number" ||
      !record(value.model) || typeof value.model.id !== "string" || typeof value.model.name !== "string" || !CONNECTED_OUTPUT_TYPES.includes(value.model.outputType as ConnectedOutputType))
    throw new Error("The saved generation job could not be verified. Refresh before continuing.");
  return { ...value, input: consumerGenerationInputSchema.parse(value.input) } as Job;
}
const ASSET_KIND: Record<ConnectedOutputType, Asset["kind"]> = { image: "image", video: "video", audio: "audio", "3d": "document" };
/** Only the service's collected local original can become a project asset. */
function originalAsset(job: Job): (Asset & { mime: string }) | null {
  if (job.status !== "completed" || job.originalAvailable !== true || job.originalAvailability !== "available" || !record(job.result) || !record(job.result.original)) return null;
  const original = job.result.original, asset = original.asset;
  if (!record(asset) || typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) || !job.providerJobId ||
      original.providerJobId !== job.providerJobId || original.creditUnit !== "higgsfield_credits" || original.credits !== job.quoteCredits ||
      typeof original.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(original.sha256) || typeof original.bytes !== "number" || original.bytes <= 0 ||
      asset.generationId !== original.generationId || typeof asset.mime !== "string" || asset.url !== `/api/media/${original.generationId}` ||
      asset.kind !== { image: "image", video: "video", audio: "audio", "3d": "model" }[job.model.outputType]) return null;
  return { id: original.generationId, generationId: original.generationId, url: asset.url, kind: ASSET_KIND[job.model.outputType], mime: asset.mime,
    name: `${job.model.name} · ${job.input.prompt.slice(0, 80) || WORKFLOW_LABELS[job.model.outputType]}`, category: "Generate",
    description: `${WORKFLOW_LABELS[job.model.outputType]} · ${job.model.name} · ${job.quoteCredits} connected credits`, prompt: job.input.prompt,
    status: "Draft", version: 1, locked: false, refs: [] };
}
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

/** Catalogue-driven generation on the workspace owner's connected account.
 * Opening only reads local records; the catalogue, quotes and status checks are explicit. */
export function AtomikGenerate({ project, scope, refreshProject }: { project: Project; scope: string; refreshProject: () => Promise<void> }) {
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
  const models = catalogue?.models.filter((m) => m.outputType === input.type) ?? [];
  const model = catalogue?.models.find((m) => m.id === input.model && m.outputType === input.type) ?? null;
  const specs = model ? effectiveParameters(model) : [];
  const roles = model ? [...new Set(model.medias.flatMap((slot) => slot.roles))] : [];
  const role = roles.includes(activeRole) ? activeRole : roles[0] ?? "";
  const normalized: ConsumerGenerationInput = { type: input.type, model: input.model, prompt: input.prompt, parameters: input.parameters, medias: input.medias.map((m) => ({ role: m.role, source: identity(m.asset) })) };
  let validation = "";
  if (model) {
    try {
      if (!consumerGenerationInputSchema.safeParse(normalized).success) validation = "Review the prompt, settings and reference files.";
      else validateGenerationRequest(model, { ...normalized, medias: input.medias.map((m) => ({ role: m.role, kind: mediaKindForRole(m.role) })) });
    } catch (cause) { validation = cause instanceof CatalogueError ? cause.message : "Review the generation settings."; }
  } else validation = "Choose a model from the connected catalogue.";
  const selected = jobs.find((job) => job.id === selectedId);
  const matches = !!selected && JSON.stringify(selected.input) === JSON.stringify(normalized);
  const missing = attempts.filter((id) => !jobs.some((job) => job.id === id));
  const unresolved = missing.length > 0 || jobs.some((job) => ["dispatching", "uncertain"].includes(job.status) || (job.status === "quoted" && attempts.includes(job.id)));
  const ready = !!capability?.owner && capability.connected && !capability.suspended && !busy;
  const canQuote = ready && !validation && !unresolved && (!input.medias.length || disclosed);
  const canSubmit = ready && selected?.status === "quoted" && matches && approved && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  const change = (patch: Partial<Creative>) => { draft.set((before) => ({ ...creative(before), ...patch })); setApproved(false); setNotice(""); };
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
  const post = useCallback((body: Record<string, unknown>) => json(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [json]);
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
      const [connection, result] = await Promise.all([json("/api/higgsfield/consumer/connection"), json(`${endpoint}?${new URLSearchParams({ draftId })}`)]);
      if (!live.current || lifecycle.current !== token) return;
      if (!Array.isArray(result.jobs) || result.jobs.length > 25) throw new Error("Saved generation jobs could not be loaded.");
      const saved = result.jobs.map((job) => parseJob(job, draftId));
      confirmAttempts(saved);
      setJobs(retain(saved, attemptIds.current));
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
      const body = action === "quote" ? { action, draftId, input: consumerGenerationInputSchema.parse(normalized), idempotencyKey: crypto.randomUUID() }
        : { action, draftId, id: job?.id ?? missingId!, ...(action === "submit" ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits } : {}) };
      const result = await post(body);
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseJob(result.job, draftId); confirmAttempts([saved]); saveJob(saved);
      if (action === "quote") setNotice("Review the model, settings, wallet and exact price below before generating.");
      if (action === "submit") setNotice("Request recorded. Use Check result to recover its progress.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll((before) => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        setNotice(saved.status === "completed" ? (originalAsset(saved) ? "The original is ready to save to this project." : "The generation completed, but its original is unavailable. Refresh saved jobs before saving it.") : saved.status === "failed" ? "The connected account reported that this generation failed." : "Status checked. The saved job remains available here.");
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
    if (pending.current || !model || !role) { setError(model ? "Choose a reference role first." : "Choose a model before adding reference files."); return; }
    const token = lifecycle.current; pending.current = true; setBusy("reference"); setError("");
    try {
      const asset: GenInputAsset = await resolveGenInput(payload, scope);
      if (!live.current || lifecycle.current !== token) return;
      const kind = mediaKindForRole(role);
      if (asset.kind !== kind) throw new Error(`The role “${role}” needs a ${kind} file.`);
      if (asset.bytes > 50 * 1024 * 1024) throw new Error("Each reference file must be no larger than 50 MB.");
      if (input.medias.some((m) => m.asset.id === asset.id && m.asset.origin === asset.origin)) throw new Error("This file is already a reference.");
      const slot = model.medias.find((s) => s.roles.includes(role));
      const used = input.medias.filter((m) => slot?.roles.includes(m.role)).length;
      if (slot?.max !== undefined && used >= slot.max) throw new Error(`${model.name} accepts at most ${slot.max} reference file${slot.max === 1 ? "" : "s"}.`);
      change({ medias: [...input.medias, { role, asset: { id: asset.id, origin: asset.origin, kind: asset.kind as StoredAsset["kind"], name: asset.name, url: asset.url } }] });
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
  const settingsSummary = (job: Job) => Object.entries(job.input.parameters).map(([k, v]) => `${k.replace(/_/g, " ")} ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ");
  return <div className={styles.workspace}>
    <div className={styles.columns}>
      <section className={`suite-panel ${styles.creator}`} aria-label="Generate on the connected account">
        <div className="suite-section-heading"><div><h2>Generate</h2><p>Image, video, sound and 3D workflows from the connected account’s catalogue. Every run is quoted in connected credits and approved before it is submitted.</p></div><span className="suite-badge">Connected account</span></div>
        {capability?.owner === false ? <p className="suite-footnote">The workspace owner can use the connected account. Your Particl generation tools remain available in Runs.</p> : <>
          {capability && !capability.connected && <p className="suite-footnote">Connect or reconnect the owner’s account in <a href="/settings#engines">Workspace settings <ArrowUpRight size={12} /></a>.</p>}
          {capability?.suspended && <p role="status">Rendering is paused for this workspace. Saved jobs can still be reviewed.</p>}
          <fieldset className={styles.form} disabled={!capability?.owner || !!busy}>
            <div role="group" aria-label="Generate workflow" className={styles.workflows}>
              {CONNECTED_OUTPUT_TYPES.map((type) => <button key={type} type="button" aria-pressed={input.type === type} onClick={() => change({ type, model: "", parameters: {}, medias: [] })}>{WORKFLOW_LABELS[type]}</button>)}
            </div>
            {!catalogue ? <p className={styles.hint}>{busy === "refresh" ? "Reading the connected catalogue…" : "The connected catalogue is not loaded. Refresh to read it."}</p> : <>
              <label>Model<select aria-label="Generate model" value={model?.id ?? ""} onChange={(e) => change({ model: e.target.value, parameters: {}, medias: [] })}>
                <option value="">Choose a {WORKFLOW_LABELS[input.type].toLowerCase()} model</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}{unlimited(m) ? " · unlimited-eligible" : ""}</option>)}
              </select><small className={styles.hint}>{models.length} {WORKFLOW_LABELS[input.type].toLowerCase()} models{catalogue.complete ? "" : " (partial listing)"} · read {new Date(catalogue.fetchedAt).toLocaleTimeString()}</small></label>
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
            <label>Prompt<textarea aria-label="Generate prompt" rows={5} maxLength={5000} value={input.prompt} onChange={(e) => change({ prompt: e.target.value })} /><small className={styles.hint}>{input.prompt.length}/5000</small></label>
            {specs.length > 0 && <div className={styles.settings} role="group" aria-label="Model settings">
              {specs.map((spec) => <ParameterField key={spec.name} spec={spec} value={input.parameters[spec.name]} disabled={!!busy} onChange={(next) => { const parameters = { ...input.parameters }; if (next === undefined) delete parameters[spec.name]; else parameters[spec.name] = next; change({ parameters }); }} />)}
            </div>}
            {model && roles.length > 0 && <div className={styles.references} role="group" aria-label="Reference files">
              <span className={styles.hint}>Choose a role, then pick a project file from the library. Reference files are copied to the connected account when a quote is requested.</span>
              <div className={styles.chips} role="group" aria-label="Reference role">{roles.map((r) => <button key={r} type="button" aria-pressed={role === r} onClick={() => setActiveRole(r)}>{r.replace(/_/g, " ")} · {mediaKindForRole(r)}</button>)}</div>
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
          {validation && model && <p className={styles.hint} role="status">{validation}</p>}
          <div className={styles.actions}>
            <button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : "Get connected-credit quote"}</button>
            <button type="button" className="suite-button" disabled={!!busy} onClick={() => void refresh(true)}><RefreshCw size={14} />Refresh saved jobs</button>
            <button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void refresh(true, true)}>Reload catalogue</button>
          </div>
          {unresolved && <p role="status" className="suite-footnote">A submission needs reconciliation. Refresh saved jobs to recover it; this request will not be submitted again.</p>}
          {!!missing.length && <div className={styles.actions}><p className="suite-footnote">An earlier submission is outside the recent history. Recover its saved record before starting another generation.</p><button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void act("status", null, missing[0])}>Recover earlier submission</button></div>}
          {selected?.status === "quoted" && <div className={styles.quote} aria-label="Connected-credit quote">
            <strong>{selected.quoteCredits} connected credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
            <small>{WORKFLOW_LABELS[selected.model.outputType]} · {selected.model.name}{settingsSummary(selected) ? ` · ${settingsSummary(selected)}` : ""}{selected.input.medias.length ? ` · ${selected.input.medias.length} reference file${selected.input.medias.length === 1 ? "" : "s"}` : ""}</small>
            <p>{matches ? selected.input.prompt || "No prompt." : "The prompt, settings or references changed. Request a new quote before generating."}</p>
            <p className="suite-footnote">{selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The connected account’s active wallet is shared across its clients; the wallet and exact price are checked again before submission. Output belongs to the connected account and is billed in its credits.</p>
            <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {selected.quoteCredits} connected credits to {selected.workspaceName} for this generation.</label>
            <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Generate · ${selected.quoteCredits} connected credits`}</button>
          </div>}
        </>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </section>
      <aside className={`suite-panel ${styles.library}`} aria-label="Project library">
        <div className="suite-section-heading"><div><h2>Project library</h2><p>Pick reference files for the selected model.</p></div></div>
        <label className={styles.search}>Search assets<input aria-label="Search project assets" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <GenAssetLibrary workbenchProjectId={project.id} projectName={project.name} allowWorkspaceBrowse initialBrowseScope="project" search={search}
          onUseAsset={(asset) => void addReference(asset)} onUseReference={(asset) => void addReference(libraryInput(asset))}
          onUsePrompt={(take) => change({ prompt: take.prompt.slice(0, 5000) })} onEdit={() => {}} onUpscale={() => {}} />
      </aside>
    </div>
    <section className="suite-panel" aria-label="Saved generation jobs">
      <div className="suite-section-heading"><div><h2>Results</h2><p>Saved quotes, submissions and collected originals for this project.</p></div></div>
      {!jobs.length ? <p className="suite-footnote">No saved generation jobs yet.</p> : <div className={styles.jobs}>{jobs.map((job) => {
        const original = originalAsset(job), saved = original && project.assets.some((asset) => asset.generationId === original.generationId);
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}>
          <div><strong>{job.status === "completed" ? (original ? "Original ready" : job.originalAvailability === "deleted" ? "Completed · original deleted" : "Completed · original unavailable") : job.status === "accepted" ? "In progress" : job.status === "quoted" && job.quoteExpired === true ? "Expired quote · no dispatch recorded" : job.status === "uncertain" || job.status === "dispatching" || (attempts.includes(job.id) && job.status === "quoted") ? "Submission needs reconciliation" : job.status === "failed" ? "Generation failed" : "Saved quote"}</strong><span>{job.quoteCredits} connected credits</span></div>
          <p>{job.input.prompt || "No prompt."}</p>
          <small>{WORKFLOW_LABELS[job.model.outputType]} · {job.model.name}{settingsSummary(job) ? ` · ${settingsSummary(job)}` : ""} · {job.workspaceName}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { setSelectedId(job.id); setApproved(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || (job.status === "uncertain" && !!job.providerReceipt)) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability?.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved request" : "Check result"}</button>}
          {original && <div className={styles.result}>
            {original.kind === "image" ? <img src={original.url} alt={original.name} /> : original.kind === "video" ? <video src={original.url} controls playsInline preload="metadata" /> : original.kind === "audio" ? <audio src={original.url} controls preload="metadata" /> : <small>3D file · {original.mime === "application/zip" ? "zip archive" : "GLB model"} · download to open in Astra blender.</small>}
            <div className={styles.actions}><a className="suite-text-button" href={`${original.url}?download=1`} download>Download original</a><button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void save(job, original)}>{saved ? "In project library" : "Save to project"}</button></div>
          </div>}
          {job.status === "completed" && !original && <p className="suite-footnote">{job.originalAvailability === "deleted" ? "The original was deleted from the library. The job receipt is retained." : "The original is unavailable. Refresh saved jobs before saving it."}</p>}
        </article>;
      })}</div>}
    </section>
  </div>;
}
