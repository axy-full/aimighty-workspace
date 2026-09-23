"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { CAST_CATEGORY, CAST_LIMITS, SOUL_CINEMA, castFromBeats, newEntry, type Cast, type CastEntry, type CastKind } from "@/lib/production/cast";
import { CONNECTED_GENERATION_ENDPOINT, connectedOriginal, connectedQuoteRequest, connectedStatusRequest, connectedSubmitRequest, parseConnectedJob, type ConnectedJob } from "@/lib/higgsfield-consumer/generation-client";
import type { ConnectedCharacter } from "@/lib/higgsfield-consumer/soul-build";
import { useShell } from "@/lib/shell/state";
import type { Asset, Project } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { useWorkspace } from "@/lib/workspace/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { SoulIdHost } from "../tools/SoulIdHost";
import { AgentAction } from "./AgentAction";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";

const EMPTY: Cast = { entries: [] };
type Model = { id: string; name: string; aspectRatios: string[] };
/** Soul Cinema's ratio for an entry: a character sheet stands 3:4; an element takes the film's ratio where the model offers it. */
function ratioFor(kind: CastKind, project: Project, model: Model | null): string {
  const want = kind === "character" ? "3:4" : project.aspect === "4:5" ? "3:4" : project.aspect;
  return model?.aspectRatios.includes(want) ? want : model?.aspectRatios[0] ?? want;
}

/**
 * Production › Cast & Elements (owner's brief, 23 September): Soul Cinema on
 * the connected account builds every character and element; the results are
 * saved in the library as Cast and Elements. The cast list comes from the
 * beat sheet for free, or from the chosen agent with a prompt per entry; a
 * character can render with a Soul ID built below.
 */
export function CastStage({ projectId, scope, items, onBeats }: { projectId: string; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the cast" /></div>;
  return <CastBody editor={editor} scope={scope} items={items} onBeats={onBeats} />;
}

function CastBody({ editor, scope, items, onBeats }: { editor: ReturnType<typeof useDraftEditor>; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const p = editor.project!;
  const shell = useShell();
  const { toast } = useWorkspace();
  const scoped = useScopedFetch(scope);
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  const agent = useAgentChoice(runs.models);
  useStageFacts("cast", p);
  const cast = p.production?.cast ?? EMPTY;
  const [connected, setConnected] = useState<boolean | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [souls, setSouls] = useState<ConnectedCharacter[]>([]);
  const [quotes, setQuotes] = useState<Record<string, ConnectedJob>>({});
  const [working, setWorking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  const call = useCallback(async <T,>(body: Record<string, unknown>): Promise<T> => {
    const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !json) throw new Error(json?.error ?? "The connected account could not be reached.");
    return json;
  }, [scoped]);
  /* The account, Soul Cinema in its catalogue, and the Soul IDs Particl built. */
  useEffect(() => {
    let alive = true;
    void scoped(`${CONNECTED_GENERATION_ENDPOINT}?draftId=${encodeURIComponent(p.id)}`).then((r) => r.json()).then((j: { connection?: { connected?: boolean } }) => { if (alive) setConnected(Boolean(j.connection?.connected)); }).catch(() => { if (alive) setConnected(false); });
    void call<{ catalogue: { models: Model[] } }>({ action: "catalogue", type: "image" }).then((j) => { if (alive) setModel(j.catalogue.models.find((m) => m.id === SOUL_CINEMA) ?? null); }).catch(() => undefined);
    void call<{ characters: ConnectedCharacter[] }>({ action: "characters" }).then((j) => { if (alive) setSouls(j.characters ?? []); }).catch(() => undefined);
    return () => { alive = false; };
  }, [call, scoped, p.id]);

  const setCast = useCallback((fn: (c: Cast) => Cast) => editor.change((old) => ({ ...old, production: { ...old.production, cast: fn(old.production?.cast ?? EMPTY) } })), [editor]);
  const setEntry = useCallback((id: string, fn: (e: CastEntry) => CastEntry) => setCast((c) => ({ ...c, entries: c.entries.map((e) => (e.id === id ? fn(e) : e)) })), [setCast]);

  /* ── The agent's cast list, taken once: new names are added, names already here are kept as they are. ── */
  const castRuns = runs.jobs.filter((job) => job.kind === "cast");
  const activeCast = castRuns.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const taken = useRef(new Set<string>());
  useEffect(() => {
    const done = castRuns.find((job) => job.status === "succeeded");
    if (!done?.result?.cast || cast.agentJobId === done.id || taken.current.has(done.id)) return;
    taken.current.add(done.id);
    const proposals = done.result.cast;
    setCast((c) => {
      const names = new Set(c.entries.map((e) => e.name.trim().toLowerCase()));
      const fresh = proposals.filter((e) => !names.has(e.name.trim().toLowerCase())).map((e) => newEntry(e.kind, e.name, e.description, e.prompt));
      return { ...c, entries: [...c.entries, ...fresh].slice(0, CAST_LIMITS.entries), agentJobId: done.id };
    });
    void editor.ensureSaved().then(() => toast(`The agent cast ${proposals.length} characters and elements`));
  }, [castRuns, cast.agentJobId, setCast, editor, toast]);

  /* ── Builds in flight: followed until the account returns the original, then filed as Cast or Elements. ── */
  const followKey = cast.entries.filter((e) => e.job?.status === "submitted").map((e) => `${e.id}:${e.job!.id}`).join(",");
  useEffect(() => {
    if (!followKey) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let wait = 15;
      for (const entry of (latest.current.production?.cast ?? EMPTY).entries.filter((e) => e.job?.status === "submitted")) {
        try {
          const reply = await call<{ job: unknown; pollAfterSeconds?: number }>(connectedStatusRequest(latest.current.id, entry.job!.id));
          const job = parseConnectedJob(reply.job, latest.current.id);
          wait = Math.min(wait, Math.max(3, Number(reply.pollAfterSeconds) || 10));
          if (!alive) return;
          if (job.status === "failed") { setEntry(entry.id, (e) => ({ ...e, job: undefined })); setErrors((x) => ({ ...x, [entry.id]: "Soul Cinema did not finish this one. A failed render is not billed." })); void editor.ensureSaved(); continue; }
          const original = connectedOriginal(job);
          if (job.status !== "completed" || !original) continue;
          editor.change((old) => {
            const c = old.production?.cast ?? EMPTY;
            const e = c.entries.find((x) => x.id === entry.id);
            if (!e) return old;
            const asset: Asset = { id: original.generationId, generationId: original.generationId, kind: "image", mime: original.mime, category: CAST_CATEGORY[e.kind], name: e.name || CAST_CATEGORY[e.kind], url: original.url, description: e.description, prompt: e.prompt, status: "Draft", locked: false, version: e.takes.length + 1, refs: [], ...(e.soulId ? { soulIdentityId: e.soulId } : {}) };
            const next: CastEntry = { ...e, job: undefined, takes: [{ genId: original.generationId, at: new Date().toISOString() }, ...e.takes].slice(0, CAST_LIMITS.takes), selected: original.generationId };
            return { ...old, assets: old.assets.some((a) => a.id === asset.id) || old.assets.length >= 500 ? old.assets : [...old.assets, asset], production: { ...old.production, cast: { ...c, entries: c.entries.map((x) => (x.id === e.id ? next : x)) } } };
          });
          void editor.ensureSaved().then(() => { void refreshProjectLibrary(scope, latest.current.id); toast(`${entry.name || "The build"} is in the library as ${entry.kind === "character" ? "Cast" : "Elements"}`); });
        } catch { /* read again next tick */ }
      }
      if (alive) timer = setTimeout(() => void tick(), wait * 1000);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  const buildInput = (entry: CastEntry) => {
    const reference = entry.referenceAssetId ? latest.current.assets.find((a) => a.id === entry.referenceAssetId) : undefined;
    return {
      type: "image" as const, model: SOUL_CINEMA, prompt: entry.prompt.trim(),
      parameters: { quality: "2k", aspect_ratio: ratioFor(entry.kind, latest.current, model), ...(entry.kind === "character" && entry.soulId ? { soul_id: entry.soulId } : {}) },
      medias: reference?.uploadId ? [{ role: "image", source: { uploadId: reference.uploadId } }] : [],
    };
  };
  const price = async (entry: CastEntry) => {
    setWorking((w) => ({ ...w, [entry.id]: "Pricing on the account…" })); setErrors((x) => ({ ...x, [entry.id]: "" }));
    try {
      if (!(await editor.ensureSaved())) throw new Error("Save the project before pricing.");
      const reply = await call<{ job: unknown }>(connectedQuoteRequest(latest.current.id, buildInput(entry)));
      const job = parseConnectedJob(reply.job, latest.current.id);
      setQuotes((q) => ({ ...q, [entry.id]: job }));
    } catch (error) { setErrors((x) => ({ ...x, [entry.id]: error instanceof Error ? error.message : "Soul Cinema could not price this." })); }
    finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };
  const build = async (entry: CastEntry) => {
    const quote = quotes[entry.id];
    if (!quote) return;
    setWorking((w) => ({ ...w, [entry.id]: "Sending to Soul Cinema…" }));
    try {
      const reply = await call<{ job: unknown }>(connectedSubmitRequest(latest.current.id, quote));
      const job = parseConnectedJob(reply.job, latest.current.id);
      setQuotes((q) => { const next = { ...q }; delete next[entry.id]; return next; });
      setEntry(entry.id, (e) => ({ ...e, job: { id: job.id, status: "submitted" } }));
      void editor.ensureSaved();
    } catch (error) {
      setQuotes((q) => { const next = { ...q }; delete next[entry.id]; return next; });
      setErrors((x) => ({ ...x, [entry.id]: error instanceof Error ? error.message : "The build could not be sent." }));
    } finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };
  const uploadReference = async (entry: CastEntry, file: File) => {
    setWorking((w) => ({ ...w, [entry.id]: "Uploading…" }));
    try {
      const uploaded = await uploadWorkbench(file, undefined, scope);
      const asset: Asset = { id: uploaded.id, uploadId: uploaded.id, kind: "image", category: "Reference", name: file.name.slice(0, 200), url: uploaded.url, mime: uploaded.mime || file.type, description: `Reference for ${entry.name}`, prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
      editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
      setEntry(entry.id, (e) => ({ ...e, referenceAssetId: asset.id }));
      void editor.ensureSaved();
    } catch (error) { setErrors((x) => ({ ...x, [entry.id]: error instanceof Error ? error.message : "The reference could not be uploaded." })); }
    finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };

  const fromBeats = useMemo(() => castFromBeats(p.production?.beats, cast.entries), [p.production?.beats, cast.entries]);
  const agentModel = agent.model;
  const q = runs.quote && runs.quote.input.model === agentModel?.id && runs.quote.input.effort === agent.effort && runs.quote.input.kind === "cast" ? runs.quote : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : activeCast ? "The agent is working." : !agentModel ? "Choose an agent above." : !p.production?.beats?.scenes.length && !(p.script ?? "").trim() ? "Write the script or break it into beats first." : null;
  const readySouls = souls.filter((s) => s.status === "ready");
  const buildBlocked = connected === false ? "Connect the Higgsfield account in Workspace › Engines." : connected === null ? "Reading the connected account…" : !model ? "The connected account does not offer Soul Cinema." : null;
  const characters = cast.entries.filter((e) => e.kind === "character").length;

  return (
    <div className="pd-stage gx-enter" data-testid="cast-stage">
      <AgentBar models={runs.models} agent={agent} loaded={runs.loaded} disabled={Boolean(activeCast) || Boolean(runs.busy)} />
      {runs.pending ? (
        <div className="gx-gen-card pd-recover" role="alert">
          <p className="gx-hint">An earlier agent request was sent but not confirmed. Recovering it re-reads that exact request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={Boolean(runs.busy)} onClick={() => void runs.start()}>{runs.busy || "Recover the request"}</button>
        </div>
      ) : null}
      {runs.error ? <p className="gx-gen-error" role="alert" data-testid="agent-error">{runs.error}</p> : null}
      {connected === false ? (
        <section className="gx-gen-card pd-recover" data-testid="cast-connect">
          <p className="gx-hint">Soul Cinema runs on your connected Higgsfield account. Connect it once and every character and element here can be built.</p>
          <button type="button" className="gx-primary" onClick={() => shell.goWorkspace("engines")}>Open Workspace › Engines</button>
        </section>
      ) : null}

      <section className="gx-gen-card" aria-label="Cast list" data-testid="cast-list" data-section="list">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Cast & elements</span>
          <span className="gx-spacer" />
          <span className="gx-hint" data-testid="cast-counts">{characters} characters · {cast.entries.length - characters} elements</span>
        </div>
        <p className="gx-hint">Start from the beat sheet’s characters, locations and props, or have the agent cast the film with a Soul Cinema prompt for each. Every build is saved in the library as Cast or Elements.</p>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={!fromBeats.length} title={!p.production?.beats ? "Break the script into beats first." : undefined} onClick={() => { setCast((c) => ({ ...c, entries: [...c.entries, ...fromBeats].slice(0, CAST_LIMITS.entries) })); void editor.ensureSaved(); }} data-testid="cast-from-beats">
            {p.production?.beats ? `Add ${fromBeats.length} from the beat sheet` : "Add from the beat sheet"}
          </button>
          {!p.production?.beats ? <button type="button" className="gx-hbtn" onClick={onBeats}>Open Beats</button> : null}
          <button type="button" className="gx-hbtn" onClick={() => setCast((c) => ({ ...c, entries: [...c.entries, newEntry("character")].slice(0, CAST_LIMITS.entries) }))} data-testid="cast-add-character">+ Character</button>
          <button type="button" className="gx-hbtn" onClick={() => setCast((c) => ({ ...c, entries: [...c.entries, newEntry("element")].slice(0, CAST_LIMITS.entries) }))} data-testid="cast-add-element">+ Element</button>
        </div>
        {activeCast ? <p className="gx-hint" role="status">{agentLabel(agentFamilyOf(activeCast.model) ?? "claude")} is casting · step {Math.min(activeCast.completedSteps + 1, activeCast.totalSteps)} of {activeCast.totalSteps}</p> : null}
        <AgentAction id="cast-agent" secondary estimateLabel="Have the agent cast the film" startLabel={(c) => `Cast it · up to ${c} credits`} quote={q} busy={runs.busy} blocked={blocked}
          describe={(qq) => `${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
          onEstimate={() => void runs.estimate({ kind: "cast", model: agentModel!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
      </section>

      <section className="pd-frames" aria-label="Cast and elements" data-testid="cast-entries" data-section="entries">
        {cast.entries.map((entry) => {
          const shown = entry.selected ?? entry.takes[0]?.genId;
          const reference = entry.referenceAssetId ? p.assets.find((a) => a.id === entry.referenceAssetId) : undefined;
          const quote = quotes[entry.id];
          const building = entry.job?.status === "submitted";
          const reason = buildBlocked ?? (!entry.name.trim() ? "Name it first." : !entry.prompt.trim() ? "Write its prompt first." : null);
          return (
            <article key={entry.id} className="gx-gen-card pd-frame" data-testid="cast-entry" data-kind={entry.kind} aria-label={entry.name || "Unnamed"}>
              <div className="pd-frame-image" data-ratio={entry.kind === "character" ? "4:5" : p.aspect}>
                {shown ? <LazyMedia url={`/api/media/${shown}`} kind="image" alt={entry.name} className="gx-lazy" /> : <span className="gx-hint">{building ? "Building with Soul Cinema…" : "Not built yet"}</span>}
              </div>
              <div className="pd-row-head">
                <input className="gx-field pd-cast-name" aria-label="Name" value={entry.name} maxLength={CAST_LIMITS.name} placeholder={entry.kind === "character" ? "Character name" : "Element name"} onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, name: v })); }} />
                <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label={`${entry.name || "Entry"} kind`}>
                  {(["character", "element"] as const).map((k) => <button key={k} type="button" role="radio" className="gx-seg-btn" aria-checked={entry.kind === k} onClick={() => setEntry(entry.id, (x) => ({ ...x, kind: k, soulId: k === "character" ? x.soulId : undefined }))}><span>{k === "character" ? "Cast" : "Element"}</span></button>)}
                </div>
              </div>
              <textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Entry"} description`} value={entry.description} maxLength={CAST_LIMITS.description} placeholder="Who or what it is, where it appears" onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, description: v })); }} />
              <textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Entry"} prompt`} value={entry.prompt} maxLength={CAST_LIMITS.prompt} placeholder="What Soul Cinema should build" onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, prompt: v })); }} data-testid="cast-prompt" />
              <div className="pd-row-head">
                {entry.kind === "character" ? (
                  <label className="pd-soul"><span className="gx-hint">Soul ID</span>
                    <select aria-label={`${entry.name || "Character"} Soul ID`} value={entry.soulId ?? ""} onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, soulId: v || undefined })); }}>
                      <option value="">None</option>
                      {readySouls.map((s) => <option key={s.soulId} value={s.soulId}>{s.name}</option>)}
                    </select>
                  </label>
                ) : null}
                <label className="gx-hbtn pd-upload">
                  {reference ? "Replace reference" : "Reference image"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Upload a reference image for ${entry.name || "this entry"}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadReference(entry, f); }} />
                </label>
                {reference ? <span className="gx-hint">{reference.name}</span> : null}
              </div>
              {entry.takes.length > 1 ? (
                <div className="pd-takes" role="radiogroup" aria-label={`${entry.name} builds`}>
                  {entry.takes.map((take, i) => <button key={take.genId} type="button" role="radio" aria-checked={take.genId === shown} aria-label={`Build ${entry.takes.length - i}`} onClick={() => setEntry(entry.id, (x) => ({ ...x, selected: take.genId }))}><LazyMedia url={`/api/media/${take.genId}`} kind="image" alt="" className="gx-lazy" /></button>)}
                </div>
              ) : null}
              <div className="gx-gen-enhance">
                {quote ? (
                  <>
                    <button type="button" className="gx-primary" disabled={Boolean(working[entry.id])} onClick={() => void build(entry)} data-testid="cast-build">{working[entry.id] || `Build · ${quote.quoteCredits.toLocaleString()} Higgsfield credits`}</button>
                    <button type="button" className="gx-hbtn" onClick={() => setQuotes((all) => { const next = { ...all }; delete next[entry.id]; return next; })}>Change</button>
                  </>
                ) : (
                  <button type="button" className="gx-primary" disabled={Boolean(working[entry.id]) || Boolean(reason) || building} onClick={() => void price(entry)} data-testid="cast-price">{working[entry.id] || (building ? "Building…" : entry.takes.length ? "Price another build" : "Price with Soul Cinema")}</button>
                )}
                <button type="button" className="gx-hbtn" aria-label={`Remove ${entry.name || "this entry"}`} onClick={() => setCast((c) => ({ ...c, entries: c.entries.filter((x) => x.id !== entry.id) }))}>Remove</button>
              </div>
              {reason && !quote && !building ? <span className="gx-reason" data-testid="cast-blocked">{reason}</span> : null}
              {quote ? <span className="gx-hint">Priced on {quote.workspaceName}: billed by the connected account; a failed render is not billed.</span> : null}
              {errors[entry.id] ? <p className="gx-gen-error" role="alert">{errors[entry.id]}</p> : null}
            </article>
          );
        })}
        {!cast.entries.length ? <p className="gx-empty">No cast yet. Add from the beat sheet, let the agent cast the film, or add one by hand.</p> : null}
      </section>

      <div className="gx-extras" data-testid="page-soul" data-section="soul"><SoulIdHost scope={scope} items={items} projectId={p.id} /></div>
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}</p>
    </div>
  );
}
