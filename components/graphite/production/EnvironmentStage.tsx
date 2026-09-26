"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { useAgentAttachments } from "./use-agent-attachments";
import { PromptAttach, attachedAsset, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import {
  DEFAULT_ENVIRONMENT, ENVIRONMENT_CATEGORY, ENVIRONMENT_LIMITS, ENVIRONMENT_MODELS, environmentsFromBeats, newEnvironmentEntry, plateAsset, plateRequest,
  type Environment, type EnvironmentEntry, type EnvironmentPlate,
} from "@/lib/production/environment";
import { entryAsset } from "@/lib/production/sequence";
import { getModel } from "@/lib/models";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import type { Asset } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { useWorkspace } from "@/lib/workspace/state";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { AgentAction } from "./AgentAction";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";

type Quote = { key: string; credits: number };
type Generation = { id: string; status: string; error?: string | null };
const DONE = new Set(["succeeded", "failed", "cancelled"]);
/** Library pictures an entry can use: renders and uploads, images only. */
const isPicture = (e: LibraryEntry) => e.media === "image" && Boolean(e.url);

/**
 * Production › Environment (owner, 24 September): where the world is built,
 * before Cast & Elements. The world's shared rules, then every place with its
 * plates — rendered here at a quoted price, uploaded, or taken from the
 * library (renders and uploads alike) — and references any render follows.
 * An agent can build the world from the brief, script and beat sheet, or the
 * director builds it by hand. Plates are filed in the library as Environment.
 */
export function EnvironmentStage({ projectId, scope, items, onBeats }: { projectId: string; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the environments" /></div>;
  return <EnvironmentBody editor={editor} scope={scope} items={items} onBeats={onBeats} />;
}

function EnvironmentBody({ editor, scope, items, onBeats }: { editor: ReturnType<typeof useDraftEditor>; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const p = editor.project!;
  const { toast } = useWorkspace();
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  /* Attached to the world: the agent sees it when it builds the world and its places. */
  const attach = useAgentAttachments({ scope, project: p, change: editor.change, save: editor.ensureSaved, onChange: runs.clearQuote });
  const agent = useAgentChoice(runs.models);
  useStageFacts("boards", p);
  const env = p.production?.environment ?? DEFAULT_ENVIRONMENT;
  const pictures = useMemo(() => items.filter(isPicture), [items]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [working, setWorking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dropOver, setDropOver] = useState<string | null>(null);
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  const setEnv = useCallback((fn: (e: Environment) => Environment) => editor.change((old) => ({ ...old, production: { ...old.production, environment: fn(old.production?.environment ?? DEFAULT_ENVIRONMENT) } })), [editor]);
  const setEntry = useCallback((id: string, fn: (e: EnvironmentEntry) => EnvironmentEntry) => setEnv((e) => ({ ...e, entries: e.entries.map((x) => (x.id === id ? fn(x) : x)) })), [setEnv]);
  const fail = (id: string, error: unknown, fallback: string) => setErrors((x) => ({ ...x, [id]: error instanceof Error ? error.message : fallback }));

  /* ── The agent's world, taken once: its rules fill an empty world, new places join, places already here stay. ── */
  const envRuns = runs.jobs.filter((job) => job.kind === "environment");
  const activeEnv = envRuns.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const taken = useRef(new Set<string>());
  useEffect(() => {
    const done = envRuns.find((job) => job.status === "succeeded");
    const proposal = done?.result?.environment;
    if (!done || !proposal || env.agentJobId === done.id || taken.current.has(done.id)) return;
    taken.current.add(done.id);
    let added = 0;
    setEnv((e) => {
      const names = new Set(e.entries.map((x) => x.name.trim().toLowerCase()));
      const fresh = proposal.entries.filter((x) => !names.has(x.name.trim().toLowerCase())).map((x) => newEnvironmentEntry(x.name, x.notes, x.prompt));
      /* A place the director named but gave no prompt takes the agent's. */
      const filled = e.entries.map((x) => {
        const theirs = proposal.entries.find((y) => y.name.trim().toLowerCase() === x.name.trim().toLowerCase());
        return theirs && !x.prompt.trim() ? { ...x, prompt: theirs.prompt.slice(0, ENVIRONMENT_LIMITS.prompt), notes: x.notes.trim() ? x.notes : theirs.notes.slice(0, ENVIRONMENT_LIMITS.notes) } : x;
      });
      added = fresh.length;
      return { ...e, world: e.world.trim() ? e.world : proposal.world.slice(0, ENVIRONMENT_LIMITS.world), entries: [...filled, ...fresh].slice(0, ENVIRONMENT_LIMITS.entries), agentJobId: done.id };
    });
    void editor.ensureSaved().then(() => toast(`The agent built the world · ${added} ${added === 1 ? "place" : "places"} added`));
  }, [envRuns, env.agentJobId, setEnv, editor, toast]);

  /* ── Plates in flight: followed until they land, then filed in the library as Environment. ── */
  const pendings = env.entries.flatMap((entry) => (entry.pending ?? []).map((pend) => ({ entry, pend })));
  const pendingKey = pendings.map((x) => x.pend.jobId).join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let alive = true;
    const tick = async () => {
      for (const { entry, pend } of pendings) {
        try {
          const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(pend.jobId)}`, { headers: { "X-Workbench-Scope": scope } });
          if (!alive || !DONE.has(generation.status)) continue;
          const ok = generation.status === "succeeded";
          editor.change((old) => {
            const e = old.production?.environment ?? DEFAULT_ENVIRONMENT;
            const current = e.entries.find((x) => x.id === entry.id);
            if (!current) return old;
            const plate: EnvironmentPlate = { assetId: generation.id, at: new Date().toISOString(), source: "render" };
            const next: EnvironmentEntry = { ...current, pending: (current.pending ?? []).filter((x) => x.jobId !== pend.jobId), ...(ok ? { plates: [plate, ...current.plates].slice(0, ENVIRONMENT_LIMITS.plates), selected: generation.id } : {}) };
            const asset = plateAsset(current, { id: generation.id, generationId: generation.id, url: `/api/media/${generation.id}` }, current.plates.length + 1);
            const assets = ok && !old.assets.some((a) => a.id === asset.id) && old.assets.length < PROJECT_LIMITS.assets ? [...old.assets, asset] : old.assets;
            return { ...old, assets, production: { ...old.production, environment: { ...e, entries: e.entries.map((x) => (x.id === entry.id ? next : x)) } } };
          });
          if (!ok) setErrors((x) => ({ ...x, [entry.id]: generation.error || "This plate did not render. Nothing was billed for a failed render." }));
          void editor.ensureSaved().then(() => { if (ok) { void refreshProjectLibrary(scope, latest.current.id); toast(`${entry.name || "The plate"} is in the library as Environment`); } });
        } catch { /* the next tick reads it again */ }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, scope]);

  /* ── Pictures in: an upload, or a render or upload from the library, as a plate or as a reference. ── */
  /** A library picture as a project asset; one already here keeps its record, a plain take is filed as Environment. */
  const adopt = (entry: EnvironmentEntry, lib: LibraryEntry, asPlate: boolean): Asset | null => {
    const id = lib.take.sourceId;
    const known = latest.current.assets.find((a) => a.id === id || a.generationId === id || a.uploadId === id);
    if (known) {
      if (asPlate && (!known.category || known.category === "Take" || known.category === "Reference")) editor.change((old) => ({ ...old, assets: old.assets.map((a) => (a.id === known.id ? { ...a, category: ENVIRONMENT_CATEGORY, name: entry.name.trim() || a.name } : a)) }));
      return known;
    }
    if (latest.current.assets.length >= PROJECT_LIMITS.assets) { setErrors((x) => ({ ...x, [entry.id]: "The project’s asset library is full." })); return null; }
    const base = entryAsset(lib);
    const asset: Asset = asPlate ? plateAsset(entry, base, entry.plates.length + 1) : { ...base, category: "Reference" };
    editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
    return asset;
  };
  const addReference = (entry: EnvironmentEntry, lib: LibraryEntry) => {
    if (entry.references.length >= ENVIRONMENT_LIMITS.references) { setErrors((x) => ({ ...x, [entry.id]: `A place takes up to ${ENVIRONMENT_LIMITS.references} references.` })); return; }
    const asset = adopt(entry, lib, false);
    if (!asset) return;
    setEntry(entry.id, (e) => (e.references.includes(asset.id) ? e : { ...e, references: [...e.references, asset.id].slice(0, ENVIRONMENT_LIMITS.references) }));
    void editor.ensureSaved();
  };
  /* Attached to a place's notes or plate prompt: pictures become its references (what the plate render follows). */
  const attachToPlace = (entry: EnvironmentEntry) => async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const placed: string[] = [], kept = [...unreadable];
    let refs = latest.current.production?.environment?.entries.find((e) => e.id === entry.id)?.references ?? entry.references;
    for (const m of media) {
      if (m.kind !== "image") { kept.push(m.name); continue; }
      if (refs.length >= ENVIRONMENT_LIMITS.references) { kept.push(m.name); continue; }
      const known = latest.current.assets.find((a) => a.id === m.id || a.generationId === m.id || a.uploadId === m.id);
      const asset = known ?? attachedAsset(m, "Reference", `Reference for ${entry.name || "a place"}`);
      if (!known) editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
      if (!refs.includes(asset.id)) refs = [...refs, asset.id];
      placed.push(m.name);
    }
    if (placed.length) { const next = refs; setEntry(entry.id, (e) => ({ ...e, references: next.slice(0, ENVIRONMENT_LIMITS.references) })); await editor.ensureSaved(); }
    return [placed.length ? `${placed.join(", ")} ${placed.length === 1 ? "is a reference" : "are references"} for ${entry.name || "this place"}.` : "", keptNote(kept, `a place's references are pictures, up to ${ENVIRONMENT_LIMITS.references}.`) ?? ""].filter(Boolean).join(" ") || null;
  };
  const takePlate = (entry: EnvironmentEntry, lib: LibraryEntry) => {
    const asset = adopt(entry, lib, true);
    if (!asset) return;
    setEntry(entry.id, (e) => ({ ...e, plates: e.plates.some((x) => x.assetId === asset.id) ? e.plates : [{ assetId: asset.id, at: new Date().toISOString(), source: "library" as const }, ...e.plates].slice(0, ENVIRONMENT_LIMITS.plates), selected: asset.id }));
    void editor.ensureSaved().then(() => refreshProjectLibrary(scope, latest.current.id));
  };
  const upload = async (entry: EnvironmentEntry, file: File, asPlate: boolean) => {
    setWorking((w) => ({ ...w, [entry.id]: "Uploading…" })); setErrors((x) => ({ ...x, [entry.id]: "" }));
    try {
      if (!/^image\//.test(file.type)) throw new Error(`${file.name} is not an image.`);
      if (!asPlate && entry.references.length >= ENVIRONMENT_LIMITS.references) throw new Error(`A place takes up to ${ENVIRONMENT_LIMITS.references} references.`);
      const uploaded = await uploadWorkbench(file, undefined, scope);
      const base = { id: uploaded.id, uploadId: uploaded.id, url: uploaded.url, mime: uploaded.mime || file.type };
      const asset: Asset = asPlate ? plateAsset(entry, base, entry.plates.length + 1)
        : { ...base, kind: "image", category: "Reference", name: file.name.slice(0, 200), description: `Reference for ${entry.name || "a place"}`, prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
      editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset].slice(0, PROJECT_LIMITS.assets) }));
      setEntry(entry.id, (e) => asPlate
        ? { ...e, plates: [{ assetId: asset.id, at: new Date().toISOString(), source: "upload" as const }, ...e.plates].slice(0, ENVIRONMENT_LIMITS.plates), selected: asset.id }
        : { ...e, references: [...e.references, asset.id].slice(0, ENVIRONMENT_LIMITS.references) });
      if (!(await editor.ensureSaved())) throw new Error("The picture uploaded, but the project is not saved yet.");
      if (asPlate) { void refreshProjectLibrary(scope, latest.current.id); toast(`${file.name} is a plate for ${entry.name || "this place"}`); }
    } catch (error) { fail(entry.id, error, "The picture could not be uploaded."); }
    finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };
  /* Anything dropped on a place: a picture from anywhere, or picture files from the device. On the plate it becomes the plate; elsewhere on the card, a reference. */
  const dropOn = (entry: EnvironmentEntry, e: React.DragEvent, asPlate: boolean) => {
    e.preventDefault(); e.stopPropagation(); setDropOver(null);
    const { ids, files } = readDrop(e.dataTransfer, p.assets);
    for (const id of ids) {
      const lib = items.find((x) => x.take.id === id);
      if (!lib) { setErrors((x) => ({ ...x, [entry.id]: "That asset is not in this project's Library." })); continue; }
      if (!isPicture(lib)) { setErrors((x) => ({ ...x, [entry.id]: `Only pictures can be ${asPlate ? "a plate" : "references"} for a place.` })); continue; }
      if (asPlate) { takePlate(entry, lib); toast(`${lib.take.name} is the plate for ${entry.name || "this place"}`); }
      else { addReference(entry, lib); toast(`${lib.take.name} is a reference for ${entry.name || "this place"}`); }
    }
    void (async () => { for (const file of files) await upload(entry, file, asPlate); })();
  };

  /* ── Rendering a plate through the quoted /api/generate path, as Storyboards does. ── */
  const quoteKey = (entry: EnvironmentEntry) => JSON.stringify([entry.prompt, entry.name, env.world, env.model, entry.references, p.aspect]);
  const price = async (entry: EnvironmentEntry) => {
    setWorking((w) => ({ ...w, [entry.id]: "Pricing…" })); setErrors((x) => ({ ...x, [entry.id]: "" }));
    try {
      if (!(await editor.ensureSaved())) throw new Error("Save the project before pricing a plate.");
      const input = plateRequest(latest.current, env, entry, getModel(env.model));
      if (!input) throw new Error(entry.prompt.trim() || entry.name.trim() ? "Save the project to link its production first." : "Name the place or write its prompt first.");
      const fresh = await studioRequest<{ estimatedCredits: number }>("/api/generate/quote", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify(generationRequestBody(input)) });
      setQuotes((q) => ({ ...q, [entry.id]: { key: quoteKey(entry), credits: fresh.estimatedCredits } }));
    } catch (error) { fail(entry.id, error, "This plate could not be priced."); }
    finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };
  const render = async (entry: EnvironmentEntry, shown: number) => {
    const input = plateRequest(latest.current, env, entry, getModel(env.model));
    if (!input) return;
    setWorking((w) => ({ ...w, [entry.id]: "Sending…" }));
    try {
      const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, p.id, `env-${entry.id}`), shown, request: { endpoint: "/api/generate", input } });
      if (outcome.state === "repriced") { setQuotes((q) => ({ ...q, [entry.id]: { key: quoteKey(entry), credits: outcome.credits } })); setErrors((x) => ({ ...x, [entry.id]: outcome.reason })); return; }
      if (outcome.state === "refused") { setErrors((x) => ({ ...x, [entry.id]: outcome.reason })); return; }
      setQuotes((q) => { const next = { ...q }; delete next[entry.id]; return next; });
      setEntry(entry.id, (e) => ({ ...e, pending: [...(e.pending ?? []), { jobId: outcome.jobId, at: new Date().toISOString() }].slice(-5) }));
      void editor.ensureSaved();
    } catch (error) { fail(entry.id, error, "The plate could not be sent."); }
    finally { setWorking((w) => ({ ...w, [entry.id]: "" })); }
  };

  const fromBeats = useMemo(() => environmentsFromBeats(p.production?.beats, env.entries), [p.production?.beats, env.entries]);
  const agentModel = agent.model;
  const q = runs.quote && runs.quote.input.model === agentModel?.id && runs.quote.input.effort === agent.effort && runs.quote.input.kind === "environment" ? runs.quote : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : activeEnv ? "The agent is working."
    : !agentModel ? "Choose an agent above." : !p.production?.beats?.scenes.length && !(p.script ?? "").trim() && !p.brief.trim() ? "Write the brief or the script, or break it into beats, first." : null;
  const withPlates = env.entries.filter((e) => e.selected).length;
  const assetOf = (id: string | undefined) => (id ? p.assets.find((a) => a.id === id) : undefined);
  const urlOf = (id: string | undefined) => { const a = assetOf(id); return a?.url ?? (id ? `/api/media/${id}` : ""); };

  return (
    <div className="pd-stage gx-enter" data-testid="environment-stage">
      <AgentBar models={runs.models} agent={agent} loaded={runs.loaded} disabled={Boolean(activeEnv) || Boolean(runs.busy)} />
      {runs.pending ? (
        <div className="gx-gen-card pd-recover" role="alert">
          <p className="gx-hint">An earlier agent request was sent but not confirmed. Recovering it re-reads that exact request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={Boolean(runs.busy)} onClick={() => void runs.start()}>{runs.busy || "Recover the request"}</button>
        </div>
      ) : null}
      {runs.error ? <p className="gx-gen-error" role="alert" data-testid="agent-error">{runs.error}</p> : null}

      <section className="gx-gen-card" aria-label="The world" data-testid="environment-world" data-section="world">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">The world</span>
          <span className="gx-spacer" />
          <span className="gx-hint" data-testid="environment-counts">{env.entries.length} {env.entries.length === 1 ? "place" : "places"} · {withPlates} with a plate</span>
        </div>
        <p className="gx-hint">What every place in the film shares — the period, the season and weather, the light, the palette and the materials. Every plate rendered here follows it.</p>
        <PromptAttach scope={scope} projectId={p.id} onAttach={attach.onAttach} label="Attach for the agent" testId="environment-world-attach"><textarea className="gx-textarea pd-small" aria-label="The world" value={env.world} maxLength={ENVIRONMENT_LIMITS.world} placeholder="Late winter on a northern coast: low sun, salt haze, weathered timber and iron…"
          onChange={(e) => { const v = e.target.value; setEnv((x) => ({ ...x, world: v })); }} data-testid="environment-world-text" />{attach.chips}</PromptAttach>
        <div className="pd-row-head">
          <span className="gx-hint">Engine</span>
          <div className="gx-seg gx-seg--sm pd-engines" role="radiogroup" aria-label="Plate engine">
            {ENVIRONMENT_MODELS.map((m) => <button key={m.id} type="button" role="radio" className="gx-seg-btn" aria-checked={env.model === m.id} onClick={() => setEnv((x) => ({ ...x, model: m.id }))}><span>{m.label}</span></button>)}
          </div>
          <span className="gx-hint">{p.aspect} · each plate priced before it renders</span>
        </div>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={!fromBeats.length} title={!p.production?.beats ? "Break the script into beats first." : undefined}
            onClick={() => { setEnv((x) => ({ ...x, entries: [...x.entries, ...fromBeats].slice(0, ENVIRONMENT_LIMITS.entries) })); void editor.ensureSaved(); }} data-testid="environment-from-beats">
            {p.production?.beats ? `Add ${fromBeats.length} ${fromBeats.length === 1 ? "place" : "places"} from the beat sheet` : "Add places from the beat sheet"}
          </button>
          {!p.production?.beats ? <button type="button" className="gx-hbtn" onClick={onBeats}>Open Beats</button> : null}
          <button type="button" className="gx-hbtn" onClick={() => setEnv((x) => ({ ...x, entries: [...x.entries, newEnvironmentEntry()].slice(0, ENVIRONMENT_LIMITS.entries) }))} data-testid="environment-add">+ Place</button>
        </div>
      </section>

      <section className="gx-gen-card" aria-label="The agent" data-testid="environment-agent" data-section="agent">
        <span className="gx-eyebrow" data-functional-label="">Build it with the agent · optional</span>
        <p className="gx-hint">The agent reads the brief, the script and the beat sheet and writes the world’s rules and every place with a plate prompt. What you wrote is kept; you can also build the world entirely by hand.</p>
        {activeEnv ? <p className="gx-hint" role="status">{agentLabel(agentFamilyOf(activeEnv.model) ?? "claude")} is building the world · step {Math.min(activeEnv.completedSteps + 1, activeEnv.totalSteps)} of {activeEnv.totalSteps}</p> : null}
        <AgentAction id="environment-agent" secondary estimateLabel="Have the agent build the world" startLabel={(price) => `Build the world · up to ${price}`} quote={q} busy={runs.busy} blocked={blocked}
          describe={(qq, price) => `${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${price}`}
          onEstimate={() => void runs.estimate({ kind: "environment", model: agentModel!.id, effort: agent.effort, ...attach.input })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
      </section>

      <section className="pd-frames" aria-label="Places" data-testid="environment-entries" data-section="places">
        {env.entries.map((entry) => {
          const shown = entry.selected ?? entry.plates[0]?.assetId;
          const quote = quotes[entry.id] && quotes[entry.id].key === quoteKey(entry) ? quotes[entry.id] : null;
          const rendering = Boolean(entry.pending?.length);
          const reason = !entry.name.trim() && !entry.prompt.trim() ? "Name the place or write its prompt first." : null;
          return (
            <article key={entry.id} className="gx-gen-card pd-frame" data-testid="environment-entry" aria-label={entry.name || "Unnamed place"} data-drop={dropOver === entry.id || undefined}
              onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(entry.id); } }}
              onDragLeave={() => setDropOver((v) => (v === entry.id ? null : v))}
              onDrop={(e) => dropOn(entry, e, false)}>
              <div className="pd-frame-image" data-ratio={p.aspect} data-testid="environment-plate-drop" onDrop={(e) => dropOn(entry, e, true)}>
                {shown ? <LazyMedia url={urlOf(shown)} kind="image" alt={entry.name} className="gx-lazy" /> : <span className="gx-hint">{rendering ? "Rendering the plate…" : "No plate yet"}</span>}
              </div>
              <input className="gx-field pd-cast-name" aria-label="Place name" value={entry.name} maxLength={ENVIRONMENT_LIMITS.name} placeholder="Place name" onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, name: v })); }} data-testid="environment-name" />
              <PromptAttach scope={scope} projectId={p.id} onAttach={attachToPlace(entry)} testId="environment-notes-attach"><textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Place"} notes`} value={entry.notes} maxLength={ENVIRONMENT_LIMITS.notes} placeholder="What it is, which scenes use it, what happens there"
                onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, notes: v })); }} /></PromptAttach>
              <PromptAttach scope={scope} projectId={p.id} onAttach={attachToPlace(entry)} testId="environment-prompt-attach"><textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Place"} plate prompt`} value={entry.prompt} maxLength={ENVIRONMENT_LIMITS.prompt} placeholder="The plate: layout, light, weather, time of day — no people"
                onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, prompt: v })); }} data-testid="environment-prompt" /></PromptAttach>

              <div className="pd-row-head" data-testid="environment-references">
                <span className="gx-hint">References {entry.references.length}/{ENVIRONMENT_LIMITS.references}</span>
                {entry.references.map((id) => (
                  <span key={id} className="pd-ref-chip">
                    <LazyMedia url={urlOf(id)} kind="image" alt={assetOf(id)?.name ?? "Reference"} className="gx-lazy" />
                    <button type="button" className="gx-hbtn" aria-label={`Remove reference ${assetOf(id)?.name ?? ""}`} onClick={() => setEntry(entry.id, (x) => ({ ...x, references: x.references.filter((r) => r !== id) }))}>×</button>
                  </span>
                ))}
              </div>
              <div className="pd-row-head">
                <select aria-label={`Add a reference to ${entry.name || "this place"}`} value="" disabled={!pictures.length || entry.references.length >= ENVIRONMENT_LIMITS.references}
                  onChange={(e) => { const lib = pictures.find((x) => x.take.id === e.target.value); if (lib) addReference(entry, lib); }} data-testid="environment-add-reference">
                  <option value="">{pictures.length ? "Reference from the library…" : "No pictures in the library yet"}</option>
                  {pictures.map((x) => <option key={x.take.id} value={x.take.id}>{x.take.kind === "UPLOAD" ? "Upload" : "Render"} · {x.take.name}</option>)}
                </select>
                <label className="gx-hbtn pd-upload">
                  Upload a reference
                  <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Upload a reference for ${entry.name || "this place"}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(entry, f, false); }} data-testid="environment-upload-reference" />
                </label>
              </div>

              <div className="pd-row-head">
                <select aria-label={`Use a library picture as the plate for ${entry.name || "this place"}`} value="" disabled={!pictures.length}
                  onChange={(e) => { const lib = pictures.find((x) => x.take.id === e.target.value); if (lib) takePlate(entry, lib); }} data-testid="environment-use-plate">
                  <option value="">{pictures.length ? "Plate from the library…" : "No pictures in the library yet"}</option>
                  {pictures.map((x) => <option key={x.take.id} value={x.take.id}>{x.take.kind === "UPLOAD" ? "Upload" : "Render"} · {x.take.name}</option>)}
                </select>
                <label className="gx-hbtn pd-upload">
                  Upload a plate
                  <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Upload a plate for ${entry.name || "this place"}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(entry, f, true); }} data-testid="environment-upload-plate" />
                </label>
              </div>

              {entry.plates.length > 1 ? (
                <div className="pd-takes" role="radiogroup" aria-label={`${entry.name || "Place"} plates`}>
                  {entry.plates.map((plate, i) => <button key={plate.assetId} type="button" role="radio" aria-checked={plate.assetId === shown} aria-label={`Plate ${entry.plates.length - i} · ${plate.source}`} onClick={() => setEntry(entry.id, (x) => ({ ...x, selected: plate.assetId }))}><LazyMedia url={urlOf(plate.assetId)} kind="image" alt="" className="gx-lazy" /></button>)}
                </div>
              ) : null}
              <div className="gx-gen-enhance">
                {quote ? (
                  <>
                    <button type="button" className="gx-primary" disabled={Boolean(working[entry.id])} onClick={() => void render(entry, quote.credits)} data-testid="environment-render">{working[entry.id] || `Render a plate · ${quote.credits.toLocaleString()} credits`}</button>
                    <button type="button" className="gx-hbtn" onClick={() => setQuotes((all) => { const next = { ...all }; delete next[entry.id]; return next; })}>Change</button>
                  </>
                ) : (
                  <button type="button" className="gx-primary" disabled={Boolean(working[entry.id]) || Boolean(reason) || rendering} onClick={() => void price(entry)} data-testid="environment-price">
                    {working[entry.id] || (rendering ? "Rendering…" : entry.plates.length ? "Price another plate" : "Price a plate")}
                  </button>
                )}
                <button type="button" className="gx-hbtn" aria-label={`Remove ${entry.name || "this place"}`} onClick={() => setEnv((x) => ({ ...x, entries: x.entries.filter((y) => y.id !== entry.id) }))}>Remove</button>
              </div>
              {reason && !quote ? <span className="gx-reason" data-testid="environment-blocked">{reason}</span> : null}
              {errors[entry.id] ? <p className="gx-gen-error" role="alert">{errors[entry.id]}</p> : null}
            </article>
          );
        })}
        {!env.entries.length ? <p className="gx-empty">No places yet. Add them from the beat sheet, let the agent build the world, or add one by hand.</p> : null}
      </section>
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}</p>
    </div>
  );
}
