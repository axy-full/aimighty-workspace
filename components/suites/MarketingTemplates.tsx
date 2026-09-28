"use client";
/* eslint-disable @next/next/no-img-element -- Catalogue previews and private originals are plain images. */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { Asset, Project } from "@/lib/workbench/studio";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { workbenchScopeFor } from "@/lib/workbench/request-scope";
import {
  MARKETING_TEMPLATE_CATEGORIES,
  MARKETING_TEMPLATE_LIMITS,
  TEMPLATE_ID,
  consumerMarketingTemplateInputSchema,
  type ConsumerMarketingTemplateInput,
} from "@/lib/higgsfield-consumer/marketing-templates";
import { awaitingReconciliation, setAsideUnconfirmed, SET_ASIDE_LABEL } from "@/lib/higgsfield-consumer/job-state";
import styles from "./marketing-templates.module.css";

export const TEMPLATE_ASSET_CATEGORY = "Campaign template";
const endpoint = "/api/higgsfield/consumer/marketing-templates";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type Capability = { owner: boolean; connected: boolean; suspended: boolean };
export type TemplateCard = {
  id: string; name: string; category: string; description: string; previewUrl: string | null;
  outputKind: "image" | "video"; inputs: string[]; credits: number | null; priceSource: "cost_table" | "catalogue" | null;
};
type Listing = { templates: TemplateCard[]; matched: number; total: number; loaded: number; complete: boolean; fetchedAt: number; categories: string[]; costsVersion: string | null };
export type TemplateSelection = Pick<TemplateCard, "id" | "name" | "category" | "previewUrl" | "outputKind" | "credits" | "priceSource">;
type Job = {
  id: string; draftId: string; status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerMarketingTemplateInput; template: { id: string; name: string; category: string; previewUrl: string | null };
  outputKind: "image" | "video"; priceSource: "get_cost" | "cost_table" | "catalogue"; costsVersion: string | null;
  workspaceId: string; workspaceName: string; quoteCredits: number; creditUnit: "higgsfield_credits"; quoteExpiresAt: number;
  quoteExpired?: boolean; providerJobId: string | null; result?: unknown; providerReceipt?: unknown;
  originalAvailable?: boolean; originalAvailability?: string; createdAt: number;
};
class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const preflightCodes = new Set(["quote_expired", "quote_changed", "workspace_changed", "unapproved_adjustment", "insufficient_credits", "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed", "connection_busy", "template_unknown", "price_unknown", "contract_unverified"]);
const recoverable = (job: Job) => ["dispatching", "accepted", "uncertain"].includes(job.status);
const retain = (jobs: Job[], attempted: string[]) => {
  const pin = (job: Job) => recoverable(job) || (job.status === "quoted" && attempted.includes(job.id));
  return [...jobs.filter(pin), ...jobs.filter((job) => !pin(job))].slice(0, 25);
};
const priceLabel = (source: Job["priceSource"], version: string | null) =>
  source === "get_cost" ? "Exact price from the connected account’s preflight."
    : `Approved exact price from the template catalogue’s cost table${version ? ` (version ${version})` : ""}; the create tool advertises no preflight quote.`;
function parseCard(value: unknown): TemplateCard | null {
  if (!record(value) || typeof value.id !== "string" || !TEMPLATE_ID.test(value.id) || typeof value.name !== "string" || typeof value.category !== "string" ||
      !["image", "video"].includes(String(value.outputKind))) return null;
  const preview = typeof value.previewUrl === "string" && /^https:\/\//.test(value.previewUrl) ? value.previewUrl : null;
  const credits = typeof value.credits === "number" && Number.isFinite(value.credits) && value.credits > 0 ? value.credits : null;
  return {
    id: value.id, name: value.name.slice(0, 200), category: value.category.slice(0, 200), description: typeof value.description === "string" ? value.description.slice(0, 2000) : "",
    previewUrl: preview, outputKind: value.outputKind as "image" | "video", inputs: Array.isArray(value.inputs) ? value.inputs.filter((v): v is string => typeof v === "string").slice(0, 16) : [],
    credits, priceSource: value.priceSource === "cost_table" || value.priceSource === "catalogue" ? value.priceSource : null,
  };
}
function parseListing(value: unknown): Listing {
  if (!record(value) || !Array.isArray(value.templates) || value.templates.length > 1200) throw new Error("The template catalogue could not be read.");
  const templates = value.templates.map(parseCard);
  if (templates.some((card) => card === null)) throw new Error("The template catalogue could not be read.");
  return {
    templates: templates as TemplateCard[], matched: Number(value.matched) || 0, total: Number(value.total) || 0, loaded: Number(value.loaded) || 0,
    complete: value.complete !== false, fetchedAt: Number(value.fetchedAt) || Date.now(),
    categories: Array.isArray(value.categories) ? value.categories.filter((v): v is string => typeof v === "string").slice(0, 64) : [],
    costsVersion: typeof value.costsVersion === "string" ? value.costsVersion.slice(0, 200) : null,
  };
}
function parseJob(value: unknown, draftId: string): Job {
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
      !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
      typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" || value.workspaceName.length > 200 ||
      value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !Number.isFinite(value.quoteCredits) || value.quoteCredits <= 0 || value.quoteCredits > 100000 ||
      !(value.providerJobId === null || (typeof value.providerJobId === "string" && uuid.test(value.providerJobId))) ||
      typeof value.quoteExpiresAt !== "number" || typeof value.createdAt !== "number" ||
      !record(value.template) || typeof value.template.id !== "string" || typeof value.template.name !== "string" || typeof value.template.category !== "string" ||
      !["image", "video"].includes(String(value.outputKind)) || !["get_cost", "cost_table", "catalogue"].includes(String(value.priceSource)))
    throw new Error("The saved template job could not be verified. Refresh before continuing.");
  return { ...value, input: consumerMarketingTemplateInputSchema.parse(value.input), costsVersion: typeof value.costsVersion === "string" ? value.costsVersion : null } as Job;
}
/** Only the service's collected local original can become a project asset. */
function originalAsset(job: Job): Asset | null {
  if (job.status !== "completed" || job.originalAvailable !== true || job.originalAvailability !== "available" || !record(job.result) || !record(job.result.original)) return null;
  const original = job.result.original, asset = original.asset;
  if (!record(asset) || typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) || !job.providerJobId ||
      original.providerJobId !== job.providerJobId || original.creditUnit !== "higgsfield_credits" || original.credits !== job.quoteCredits ||
      typeof original.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(original.sha256) || typeof original.bytes !== "number" || original.bytes <= 0 ||
      asset.generationId !== original.generationId || typeof asset.mime !== "string" || asset.url !== `/api/media/${original.generationId}` || asset.kind !== job.outputKind) return null;
  return { id: original.generationId, generationId: original.generationId, url: asset.url, kind: job.outputKind, mime: asset.mime,
    name: `${job.template.name} · ${job.input.prompt.slice(0, 80) || "template variant"}`, category: TEMPLATE_ASSET_CATEGORY,
    description: `Template variant · ${job.template.name} · ${job.quoteCredits} connected credits`, prompt: job.input.prompt,
    status: "Draft", version: 1, locked: false, refs: [] };
}
const selectionEvent = "particl-marketing-template-selection";
const subscribe = (notify: () => void) => { window.addEventListener("storage", notify); window.addEventListener(selectionEvent, notify); return () => { window.removeEventListener("storage", notify); window.removeEventListener(selectionEvent, notify); }; };
const noSelection = () => null;
const selectionKey = (scope: string, draftId: string) => `particl-marketing-template:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}`;
function readSelection(raw: string | null): TemplateSelection | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || typeof value.id !== "string" || !TEMPLATE_ID.test(value.id) || typeof value.name !== "string" || typeof value.category !== "string" || !["image", "video"].includes(String(value.outputKind))) return null;
    return { id: value.id, name: value.name.slice(0, 200), category: value.category.slice(0, 200), outputKind: value.outputKind as "image" | "video",
      previewUrl: typeof value.previewUrl === "string" && /^https:\/\//.test(value.previewUrl) ? value.previewUrl : null,
      credits: typeof value.credits === "number" && value.credits > 0 ? value.credits : null, priceSource: value.priceSource === "cost_table" || value.priceSource === "catalogue" ? value.priceSource : null };
  } catch { return null; }
}
function useTemplateSelection(scope: string, draftId: string) {
  const key = selectionKey(scope, draftId);
  const read = useCallback(() => { try { return localStorage.getItem(key); } catch { return null; } }, [key]);
  const stored = useSyncExternalStore(subscribe, read, noSelection);
  const write = useCallback((next: TemplateSelection | null) => {
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); window.dispatchEvent(new Event(selectionEvent)); } catch { /* Selection stays in memory for this page. */ }
  }, [key]);
  return [readSelection(stored), write] as const;
}
function useCapability(scope: string, draftId: string, enabled: boolean) {
  const request = useScopedFetch(scope);
  const json = useCallback(async (url: string, init?: RequestInit) => {
    const response = await request(url, { cache: "no-store", ...init });
    const result = await response.json().catch(() => null);
    if (!response.ok || !record(result)) throw new RequestError(typeof result?.error === "string" ? result.error : "The request could not be completed. Refresh saved jobs before continuing.", response.status, typeof result?.code === "string" ? result.code : undefined);
    return result;
  }, [request]);
  const post = useCallback((body: Record<string, unknown>) => json(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), [json]);
  /** Reads identity, connection and saved jobs; never a provider call. */
  const load = useCallback(async () => {
    const me = await json("/api/me");
    if (typeof me.id !== "string" || !record(me.workspace) || typeof me.workspace.id !== "string" || workbenchScopeFor(me.workspace.id, me.id) !== scope)
      throw new Error("Your account or workspace changed. Reload this project before continuing.");
    if (me.owner !== true) return { capability: { owner: false, connected: false, suspended: false } as Capability, jobs: [] as Job[] };
    const [connection, result] = await Promise.all([json("/api/higgsfield/consumer/connection"), json(`${endpoint}?${new URLSearchParams({ draftId })}`)]);
    if (!Array.isArray(result.jobs) || result.jobs.length > 25) throw new Error("Saved template jobs could not be loaded.");
    return {
      capability: { owner: true, connected: connection.connected === true && connection.requiresReconnect !== true, suspended: me.workspace.suspended === true } as Capability,
      jobs: result.jobs.map((job) => parseJob(job, draftId)),
    };
  }, [json, scope, draftId]);
  return { json, post, load, enabled };
}

/** Format section: browse the connected account's template catalogue and pick one. */
export function MarketingTemplateBrowser({ project, scope, enabled, onPicked }: { project: Project; scope: string; enabled: boolean; onPicked?: () => void }) {
  const { post, load } = useCapability(scope, project.id, enabled);
  const [selection, select] = useTemplateSelection(scope, project.id);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [category, setCategory] = useState<string>("all"), [search, setSearch] = useState("");
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const pending = useRef(false), live = useRef(false), lifecycle = useRef(0);
  const refresh = useCallback(async (refreshCatalogue = false) => {
    if (!enabled || pending.current) return;
    const token = lifecycle.current;
    pending.current = true; setBusy("refresh"); setError("");
    try {
      const { capability } = await load();
      if (!live.current || lifecycle.current !== token) return;
      setCapability(capability);
      if (capability.owner && capability.connected) {
        const result = await post({ action: "catalogue", limit: 400, ...(refreshCatalogue ? { refresh: true } : {}) });
        if (!live.current || lifecycle.current !== token) return;
        setListing(parseListing(result.catalogue));
      }
    } catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "The template catalogue could not be read."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [enabled, load, post]);
  useEffect(() => {
    live.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reads identity, connection and the cached catalogue once per mounted project.
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [refresh]);
  const needle = search.trim().toLowerCase();
  const visible = (listing?.templates ?? []).filter((card) => (category === "all" || card.category === category) && (!needle || `${card.name} ${card.description} ${card.category}`.toLowerCase().includes(needle)));
  const categories = [...new Set(["all", ...MARKETING_TEMPLATE_CATEGORIES.filter((c) => c !== "all"), ...(listing?.categories ?? [])])];
  return <section className={`suite-panel ${styles.panel}`} aria-label="Template catalogue">
    <div className="suite-section-heading"><div><h2>Template catalogue</h2><p>Browse the connected account’s Marketing Studio templates. Pick one here, then create with it in Variants at its exact connected-credit price.</p></div><span className="suite-badge">Connected account</span></div>
    {!enabled ? <p className="suite-footnote">Open and save a project to continue.</p> : capability?.owner === false ? <p className="suite-footnote">The workspace owner can browse the connected account’s template catalogue. Particl’s native creative briefs above remain available.</p> : <>
      {capability && !capability.connected && <p className="suite-footnote">Connect or reconnect the owner’s account in <a href="/settings#engines">Workspace settings <ArrowUpRight size={12} /></a>.</p>}
      {selection && <p role="status" className={styles.selected}>Selected template · <strong>{selection.name}</strong> · {selection.category || "uncategorised"} · {selection.outputKind}{selection.credits !== null ? ` · ${selection.credits} connected credits` : ""}<button type="button" className="suite-text-button" onClick={() => select(null)}>Clear</button></p>}
      <div className={styles.filters}>
        <label className={styles.search}>Search templates<input aria-label="Search templates" value={search} maxLength={120} onChange={(e) => setSearch(e.target.value)} placeholder="Name, category or description" /></label>
        <label>Category<select aria-label="Template category" value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : c}</option>)}</select></label>
        <button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void refresh(true)}><RefreshCw size={14} />Reload catalogue</button>
      </div>
      {listing ? <p className={styles.hint}>{visible.length} of {listing.loaded} templates{listing.total > listing.loaded ? ` (${listing.total} in the catalogue; first ${listing.loaded} loaded)` : ""}{listing.complete ? "" : " · partial listing"} · read {new Date(listing.fetchedAt).toLocaleTimeString()}{listing.costsVersion ? ` · cost table ${listing.costsVersion}` : " · no cost table loaded"}</p>
        : <p className={styles.hint}>{busy === "refresh" ? "Reading the template catalogue…" : capability?.connected ? "The template catalogue is not loaded. Reload to read it." : ""}</p>}
      {listing && <ul className={styles.grid} aria-label="Templates">{visible.slice(0, 200).map((card) => {
        const picked = selection?.id === card.id;
        return <li key={card.id}>
          <button type="button" className={styles.card} aria-pressed={picked} onClick={() => { select({ id: card.id, name: card.name, category: card.category, previewUrl: card.previewUrl, outputKind: card.outputKind, credits: card.credits, priceSource: card.priceSource }); onPicked?.(); }}>
            {card.previewUrl ? <img src={card.previewUrl} alt="" loading="lazy" /> : <span className={styles.placeholder} aria-hidden="true">{card.outputKind === "video" ? "▶" : "▣"}</span>}
            <strong>{card.name}</strong>
            <small>{card.category || "uncategorised"} · {card.outputKind}{card.inputs.length ? ` · needs ${card.inputs.join(", ")}` : ""}</small>
            <span className={styles.price}>{card.credits !== null ? `${card.credits} connected credits` : "Price on quote"}</span>
            {card.description && <p>{card.description}</p>}
          </button>
        </li>;
      })}</ul>}
      {listing && visible.length > 200 && <p className={styles.hint}>Showing the first 200 matches. Narrow the search to see the rest.</p>}
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}

function defaultInput(project: Project, presetId: string): ConsumerMarketingTemplateInput {
  const brief = project.moleculr;
  const prompt = [brief?.productName && `Product: ${brief.productName}.`, brief?.productDescription, "Use only the supplied product facts. Do not invent claims or testimonials."]
    .filter(Boolean).join("\n\n").slice(0, MARKETING_TEMPLATE_LIMITS.prompt);
  const brand = (brief?.brandKit?.name || brief?.productBrand || "").slice(0, 120);
  return { presetId, prompt, ...(brand ? { brandName: brand } : {}) };
}
const productCandidates = (project: Project) => {
  const ids = new Set(project.moleculr?.productAssetIds ?? []);
  return project.assets
    .filter((asset) => asset.kind === "image" && (asset.uploadId || (asset.generationId && !asset.generationId.startsWith("gen_hfc_"))) )
    .sort((a, b) => Number(ids.has(b.id)) - Number(ids.has(a.id)));
};
const identityOf = (asset: Asset) => (asset.uploadId ? { uploadId: asset.uploadId } : { genId: asset.generationId! });

/** Variants section: quote, approve and create with the picked template, then file the original as a variant. */
export function MarketingTemplateCreator({ project, scope, enabled, onSave, onAsset }: {
  project: Project; scope: string; enabled: boolean; onSave?: () => Promise<boolean>; onAsset?: (asset: Asset, draftId: string) => Promise<void>;
}) {
  const draftId = project.id;
  const { post, load } = useCapability(scope, draftId, enabled);
  const [selection] = useTemplateSelection(scope, draftId);
  const attemptKey = `particl-marketing-template:${encodeURIComponent(scope)}:${encodeURIComponent(draftId)}:attempts`;
  const [edit, setEdit] = useState<{ presetId: string; prompt: string; brandName: string; productAssetId: string } | null>(null);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]), [selectedId, setSelectedId] = useState(""), [attempts, setAttempts] = useState<string[]>([]);
  const [approved, setApproved] = useState(false), [disclosed, setDisclosed] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [clock, setClock] = useState(() => Date.now()), [nextPoll, setNextPoll] = useState<Record<string, number>>({});
  const pending = useRef(false), live = useRef(false), lifecycle = useRef(0), attemptIds = useRef<string[]>([]);
  const candidates = productCandidates(project);
  const defaults = selection ? defaultInput(project, selection.id) : null;
  const form = edit && edit.presetId === selection?.id ? edit : { presetId: selection?.id ?? "", prompt: defaults?.prompt ?? "", brandName: defaults?.brandName ?? "", productAssetId: "" };
  const product = candidates.find((asset) => asset.id === form.productAssetId) ?? null;
  const normalized: ConsumerMarketingTemplateInput | null = selection ? {
    presetId: selection.id, prompt: form.prompt, ...(form.brandName.trim() ? { brandName: form.brandName } : {}), ...(product ? { productImage: identityOf(product) } : {}),
  } : null;
  const valid = !!normalized && consumerMarketingTemplateInputSchema.safeParse(normalized).success;
  const selected = jobs.find((job) => job.id === selectedId);
  const matches = !!selected && !!normalized && JSON.stringify(selected.input) === JSON.stringify(normalized);
  const missing = attempts.filter((id) => !jobs.some((job) => job.id === id));
  const unresolved = missing.length > 0 || jobs.some((job) => awaitingReconciliation(job) || (job.status === "quoted" && attempts.includes(job.id)));
  const ready = enabled && !!capability?.owner && capability.connected && !capability.suspended && !busy;
  const canQuote = ready && valid && !unresolved && (!product || disclosed);
  const canSubmit = ready && selected?.status === "quoted" && matches && approved && selected.quoteExpiresAt > clock && !attempts.includes(selected.id);
  const change = (patch: Partial<typeof form>) => { setEdit({ ...form, ...patch }); setApproved(false); setNotice(""); };
  const confirmAttempts = useCallback((confirmed: Job[]) => {
    const byId = new Map(confirmed.map((job) => [job.id, job]));
    const next = attemptIds.current.filter((id) => { const job = byId.get(id); return !job || awaitingReconciliation(job) || (job.status === "quoted" && job.quoteExpired !== true); });
    try { localStorage.setItem(attemptKey, JSON.stringify(next)); attemptIds.current = next; setAttempts(next); } catch { /* Keep the guard when its resolution cannot be saved. */ }
  }, [attemptKey]);
  const saveJob = (job: Job) => { setJobs((before) => retain([job, ...before.filter((item) => item.id !== job.id)], attemptIds.current)); setSelectedId(job.id); };
  const refresh = useCallback(async () => {
    if (!enabled || pending.current) return;
    const token = lifecycle.current;
    pending.current = true; setBusy("refresh"); setError("");
    try {
      const loaded = await load();
      if (!live.current || lifecycle.current !== token) return;
      confirmAttempts(loaded.jobs);
      setJobs(retain(loaded.jobs, attemptIds.current)); setCapability(loaded.capability); setClock(Date.now());
    } catch (reason) { if (live.current && lifecycle.current === token) { setCapability(null); setError(reason instanceof Error ? reason.message : "Saved template jobs could not be loaded."); } }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }, [enabled, load, confirmAttempts]);
  useEffect(() => {
    live.current = true;
    try { const values = JSON.parse(localStorage.getItem(attemptKey) ?? "[]"); attemptIds.current = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string" && uuid.test(v)).slice(-100) : []; setAttempts(attemptIds.current); } catch { /* A later submit requires writable recovery storage. */ }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live.current = false; lifecycle.current++; pending.current = false; };
  }, [attemptKey, refresh]);
  useEffect(() => { if (!jobs.length) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [jobs.length]);
  async function act(action: "quote" | "submit" | "status", job: Job | null | undefined = selected, missingId?: string) {
    if (!enabled || pending.current || !capability?.owner) return;
    if (action === "quote" && (!canQuote || !normalized)) return;
    if (action === "submit" && (!canSubmit || !job || job.id !== selectedId)) return;
    const recovering = action === "status" && job === null && !!missingId && missing.includes(missingId);
    if (action === "status" && !recovering && (!job || !(job.status === "accepted" || (job.status === "uncertain" && job.providerReceipt)) || clock < (nextPoll[job.id] ?? 0))) return;
    const token = lifecycle.current;
    pending.current = true; setBusy(action); setError(""); setNotice("");
    try {
      if (action === "quote" && onSave && !(await onSave())) throw new Error("Save this project before requesting a template quote.");
      if (!live.current || lifecycle.current !== token) return;
      if (action === "submit") {
        const next = [...new Set([...attemptIds.current, job!.id])].slice(-100);
        try { localStorage.setItem(attemptKey, JSON.stringify(next)); } catch { throw new Error("Submission recovery could not be saved in this browser. Enable local storage before creating."); }
        attemptIds.current = next; setAttempts(next); setApproved(false);
      }
      const body = action === "quote" ? { action, draftId, input: consumerMarketingTemplateInputSchema.parse(normalized), idempotencyKey: crypto.randomUUID() }
        : { action, draftId, id: job?.id ?? missingId!, ...(action === "submit" ? { workspaceId: job!.workspaceId, credits: job!.quoteCredits } : {}) };
      const result = await post(body);
      if (!live.current || lifecycle.current !== token) return;
      const saved = parseJob(result.job, draftId); confirmAttempts([saved]); saveJob(saved);
      if (action === "quote") setNotice("Review the template, inputs, wallet and exact price below before creating.");
      if (action === "submit") setNotice("Request recorded. Use Check result to recover its progress.");
      if (action === "status") {
        const delay = typeof result.pollAfterSeconds === "number" && Number.isFinite(result.pollAfterSeconds) ? Math.min(3600, Math.max(15, result.pollAfterSeconds)) : 30;
        setNextPoll((before) => ({ ...before, [saved.id]: Date.now() + delay * 1000 }));
        setNotice(saved.status === "completed" ? (originalAsset(saved) ? "The original is ready to save as a variant." : "The template run completed, but its original is unavailable. Refresh saved jobs before saving it.") : saved.status === "failed" ? (record(result.collection) && typeof result.collection.message === "string" ? result.collection.message.slice(0, 200) : "The connected account reported that this template run failed.") : "Status checked. The saved job remains available here.");
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
  async function attach(asset: Asset) {
    if (!enabled || pending.current || !onAsset) return;
    const token = lifecycle.current; pending.current = true; setBusy("attach"); setError("");
    try { await onAsset(asset, draftId); if (live.current && lifecycle.current === token) setNotice("Original saved to the project as a template variant."); }
    catch (reason) { if (live.current && lifecycle.current === token) setError(reason instanceof Error ? reason.message : "The original could not be saved as a variant."); }
    finally { if (lifecycle.current === token) { pending.current = false; if (live.current) setBusy(""); } }
  }
  return <section className={`suite-panel ${styles.panel}`} aria-label="Create with template">
    <div className="suite-section-heading"><div><h2>Create with template</h2><p>Run the template picked in Format on the connected account. Every run is quoted in connected credits and approved before it is submitted.</p></div><span className="suite-badge">Connected account</span></div>
    {!enabled ? <p className="suite-footnote">Open and save a project to continue.</p> : capability?.owner === false ? <p className="suite-footnote">The workspace owner can create with the connected account’s templates. Your Particl variant tools above remain available.</p> : <>
      {capability && !capability.connected && <p className="suite-footnote">Connect or reconnect the owner’s account in <a href="/settings#engines">Workspace settings <ArrowUpRight size={12} /></a>.</p>}
      {capability?.suspended && <p role="status">Rendering is paused for this workspace. Saved jobs can still be reviewed.</p>}
      {!selection ? <p className="suite-footnote">No template picked yet. Choose one in the Format section’s template catalogue.</p> : <div className={styles.picked} aria-label="Picked template">
        {selection.previewUrl ? <img src={selection.previewUrl} alt="" /> : <span className={styles.placeholder} aria-hidden="true">{selection.outputKind === "video" ? "▶" : "▣"}</span>}
        <div><strong>{selection.name}</strong><small>{selection.category || "uncategorised"} · {selection.outputKind}{selection.credits !== null ? ` · ${selection.credits} connected credits listed` : " · price on quote"}</small></div>
      </div>}
      <fieldset disabled={!enabled || !capability?.owner || !!busy || !selection} className="suite-fields">
        <label className={styles.prompt}>Product or brand description<textarea aria-label="Template description" rows={5} maxLength={MARKETING_TEMPLATE_LIMITS.prompt} value={form.prompt} onChange={(e) => change({ prompt: e.target.value })} /><small>{form.prompt.length}/{MARKETING_TEMPLATE_LIMITS.prompt}</small></label>
        <div className={styles.settings}>
          <label>Brand name<input type="text" aria-label="Template brand name" maxLength={120} value={form.brandName} onChange={(e) => change({ brandName: e.target.value })} /></label>
          <label>Product image<select aria-label="Template product image" value={form.productAssetId} onChange={(e) => change({ productAssetId: e.target.value })}>
            <option value="">No product image</option>
            {candidates.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select></label>
        </div>
        {product && <label className={styles.checkbox}><input type="checkbox" checked={disclosed} onChange={(e) => setDisclosed(e.target.checked)} />I understand this project original is copied to the connected account to prepare the quote.</label>}
      </fieldset>
      <div className={styles.actions}>
        <button type="button" className="suite-primary" disabled={!canQuote} onClick={() => void act("quote")}>{busy === "quote" ? "Reading exact price…" : "Get connected-credit quote"}</button>
        <button type="button" className="suite-button" disabled={!enabled || !!busy} onClick={() => void refresh()}><RefreshCw size={14} />Refresh saved template jobs</button>
      </div>
      {unresolved && <p role="status" className="suite-footnote">A submission needs reconciliation. It is never sent again: check it below, or set it aside in Workspace › Engines.</p>}
      {!!missing.length && <div className={styles.actions}><p className="suite-footnote">An earlier submission is outside the recent history. Recover its saved record before starting another template run.</p><button type="button" className="suite-button" disabled={!!busy || !capability?.connected} onClick={() => void act("status", null, missing[0])}>Recover earlier submission</button></div>}
      {selected?.status === "quoted" && <div className={styles.quote} aria-label="Template quote">
        <strong>{selected.quoteCredits} connected credits · {selected.workspaceName}</strong><small>Wallet {selected.workspaceId}</small>
        <small>{selected.template.name} · {selected.template.category || "uncategorised"} · {selected.outputKind}{selected.input.productImage ? " · 1 product image" : ""}</small>
        <p>{matches ? selected.input.prompt || "No description." : "The template, description or product image changed. Request a new quote before creating."}</p>
        <p className="suite-footnote">{priceLabel(selected.priceSource, selected.costsVersion)} {selected.quoteExpiresAt > clock ? `Quote valid until ${new Date(selected.quoteExpiresAt).toLocaleTimeString()}.` : "This quote expired. Request a fresh quote."} The connected account’s active wallet is shared across its clients; the wallet and exact price are checked again before submission. Output belongs to the connected account and is billed in its credits.</p>
        <label className={styles.checkbox}><input type="checkbox" checked={approved} disabled={!matches || !!busy || attempts.includes(selected.id)} onChange={(e) => setApproved(e.target.checked)} />Charge {selected.quoteCredits} connected credits to {selected.workspaceName} for this template run.</label>
        <button type="button" className="suite-primary" disabled={!canSubmit} onClick={() => void act("submit")}>{busy === "submit" ? "Submitting once…" : `Create with template · ${selected.quoteCredits} connected credits`}</button>
      </div>}
      {!!jobs.length && <div className={styles.jobs} aria-label="Saved template jobs">{jobs.map((job) => {
        const original = originalAsset(job), saved = original && project.assets.some((asset) => asset.generationId === original.generationId);
        const wait = Math.max(0, Math.ceil(((nextPoll[job.id] ?? 0) - clock) / 1000));
        return <article key={job.id} className={styles.job}>
          <div><strong>{job.status === "completed" ? (original ? "Original ready" : job.originalAvailability === "deleted" ? "Completed · original deleted" : "Completed · original unavailable") : job.status === "accepted" ? "In progress" : job.status === "quoted" && job.quoteExpired === true ? "Expired quote · no dispatch recorded" : setAsideUnconfirmed(job) ? SET_ASIDE_LABEL : job.status === "uncertain" || job.status === "dispatching" || (attempts.includes(job.id) && job.status === "quoted") ? "Submission needs reconciliation" : job.status === "failed" ? "Template run failed" : "Saved quote"}</strong><span>{job.quoteCredits} connected credits</span></div>
          <p>{job.input.prompt || "No description."}</p>
          <small>{job.template.name} · {job.template.category || "uncategorised"} · {job.outputKind} · {job.workspaceName}</small>
          {job.status === "quoted" && !attempts.includes(job.id) && <button type="button" className="suite-text-button" disabled={!!busy} onClick={() => { setSelectedId(job.id); setApproved(false); }}>Review this saved quote</button>}
          {(job.status === "accepted" || (job.status === "uncertain" && !!job.providerReceipt)) && <button type="button" className="suite-button" disabled={!!busy || wait > 0 || !capability?.connected} onClick={() => void act("status", job)}>{wait ? `Check again in ${wait}s` : job.status === "uncertain" ? "Recover saved request" : "Check result"}</button>}
          {original && <div className={styles.result}>
            {original.kind === "image" ? <img src={original.url} alt={original.name} /> : <video src={original.url} controls playsInline preload="metadata" />}
            <div className={styles.actions}><a className="suite-text-button" href={`${original.url}?download=1`} download>Download original</a>{onAsset && <button type="button" className="suite-button" disabled={!!busy || !!saved} onClick={() => void attach(original)}>{saved ? "Saved as variant" : "Save as variant"}</button>}</div>
          </div>}
          {job.status === "completed" && !original && <p className="suite-footnote">{job.originalAvailability === "deleted" ? "The original was deleted from the library. The job receipt is retained." : "The original is unavailable. Refresh saved jobs before saving it."}</p>}
        </article>;
      })}</div>}
    </>}
    {notice && <p role="status" className="suite-footnote">{notice}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
