"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { PromptAttach, attachedAsset, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { entryAsset } from "@/lib/production/sequence";
import { isDroppable, readDrop } from "@/lib/drop";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { assetPreview, previewAttrs } from "@/lib/preview";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { CAST_CATEGORY, CAST_LIMITS, castFromBeats, entryCategory, mergeAgentCast, newEntry, retiredModelOf, type Cast, type CastEntry } from "@/lib/production/cast";
import { renderOutcome, renderedStills } from "@/lib/production/cast-render";
import { CONFIRM } from "@/lib/shell/confirmations";
import { castStillPrompt } from "@/lib/shell/connected-capability";
import { focusSection } from "@/lib/shell/production-tools";
import { useShell } from "@/lib/shell/state";
import { useConfirm } from "@/lib/shell/use-confirm";
import type { TakeFailure } from "@/lib/providerOutcome";
import type { Asset } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { useIdentities } from "@/lib/workspace/identities";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { openGenOn } from "../OwnerRunCard";
import { AgentAction } from "./AgentAction";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { CastIdentities, buildPrice, useBuiltIdentities } from "./CastIdentities";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";

const EMPTY: Cast = { entries: [] };
type Generation = { id: string; status: string; error?: string | null; failure?: TakeFailure | null; params?: unknown };
const DONE = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Production › Cast & Elements (owner's brief, 23 September): the cast list
 * comes from the beat sheet for free, or from the chosen agent with a prompt
 * per entry. A character's identity is built in this workspace (Build
 * identity, below, at the trainer's price) and chosen on its card; any
 * entry's still is made in Gen. The stills engines Cast used to render with
 * are no longer offered (D0.2): nothing here starts a render, a render still
 * in flight from before is followed until it lands and is filed as Cast, and
 * every earlier still stays on its card and in the Library.
 */
export function CastStage({ projectId, scope, items, onBeats }: { projectId: string; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the cast" /></div>;
  return <CastBody editor={editor} scope={scope} items={items} onBeats={onBeats} />;
}

function CastBody({ editor, scope, items, onBeats }: { editor: ReturnType<typeof useDraftEditor>; scope: string; items: LibraryEntry[]; onBeats: () => void }) {
  const p = editor.project!;
  const shell = useShell();
  const { confirm } = useConfirm();
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  const agent = useAgentChoice(runs.models);
  useStageFacts("cast", p);
  const cast = p.production?.cast ?? EMPTY;
  /* Identities built here (the trainer's own list and price), and the ones trained earlier on the retired stills engines (read only). */
  const built = useBuiltIdentities(scope);
  const earlier = useIdentities(scope, p.id).state.data?.identities;
  const ready = useMemo(() => (built.identities ?? []).filter((i) => i.status === "ready"), [built.identities]);
  const builtIds = useRef(new Set<string>());
  useEffect(() => { builtIds.current = new Set((built.identities ?? []).map((i) => i.id)); }, [built.identities]);
  const price = buildPrice(built.terms);
  /* A character's "Build identity": the card below takes its name and comes into view. */
  const [seed, setSeed] = useState<{ name: string; n: number } | null>(null);
  const buildFor = (entry: CastEntry) => { setSeed((was) => ({ name: entry.name.trim(), n: (was?.n ?? 0) + 1 })); focusSection("soul"); };
  const [working, setWorking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  /* An update that hands back what it was given changes nothing: no edit, no save. */
  const setCast = useCallback((fn: (c: Cast) => Cast) => editor.change((old) => {
    const was = old.production?.cast ?? EMPTY, next = fn(was);
    return next === was ? old : { ...old, production: { ...old.production, cast: next } };
  }), [editor]);
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
    /* The confirmation counts what was added, not what was proposed. */
    let counts = { added: 0, known: 0, overLimit: 0 };
    setCast((c) => { const merged = mergeAgentCast(c, proposals, done.id); counts = merged; return merged.cast; });
    void editor.ensureSaved().then(() => confirm(CONFIRM.castTaken(counts)));
  }, [castRuns, cast.agentJobId, setCast, editor, confirm]);

  /* ── Renders sent before the stills engines were retired: read until they land, then every still of the request is filed as Cast. ── */
  const pendingKey = cast.entries.flatMap((e) => (e.pending ?? []).map((r) => `${e.id}:${r.jobId}`)).join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let alive = true, reading = false;
    const controller = new AbortController();
    const tick = async () => {
      if (reading) return;
      reading = true;
      for (const entry of (latest.current.production?.cast ?? EMPTY).entries) {
        for (const render of entry.pending ?? []) {
          try {
            const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(render.jobId)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope } });
            if (!alive || !DONE.has(generation.status)) continue;
            const ok = generation.status === "succeeded";
            const stills = ok ? renderedStills(generation) : [];
            editor.change((old) => {
              const c = old.production?.cast ?? EMPTY;
              const e = c.entries.find((x) => x.id === entry.id);
              if (!e?.pending?.some((r) => r.jobId === render.jobId)) return old;
              const at = new Date().toISOString();
              const fresh = stills.filter((id) => !e.takes.some((t) => t.genId === id));
              const next: CastEntry = { ...e, pending: (e.pending ?? []).filter((r) => r.jobId !== render.jobId),
                ...(ok && stills.length ? { takes: [...fresh.map((genId) => ({ genId, at })), ...e.takes].slice(0, CAST_LIMITS.takes), selected: stills[0] } : {}) };
              const assets = [...old.assets];
              fresh.forEach((genId, i) => {
                if (assets.some((a) => a.id === genId) || assets.length >= PROJECT_LIMITS.assets) return;
                assets.push({ id: genId, generationId: genId, kind: "image", mime: "image/png", category: CAST_CATEGORY[e.kind], name: e.name || CAST_CATEGORY[e.kind], url: `/api/media/${genId}`,
                  description: e.description, prompt: e.prompt, status: "Draft", locked: false, version: e.takes.length + i + 1, refs: [],
                  /* The earlier identity the render was made with; an identity built here since is not it. */
                  ...(e.identityId && !builtIds.current.has(e.identityId) ? { soulIdentityId: e.identityId } : {}) } satisfies Asset);
              });
              return { ...old, assets, production: { ...old.production, cast: { ...c, entries: c.entries.map((x) => (x.id === e.id ? next : x)) } } };
            });
            if (!ok) setErrors((x) => ({ ...x, [entry.id]: renderOutcome(generation) }));
            void editor.ensureSaved().then(() => { if (ok) { void refreshProjectLibrary(scope, latest.current.id); confirm(CONFIRM.castBuilt(entry.name, entry.kind)); } });
          } catch { /* read again next tick */ }
          if (!alive) break;
        }
      }
      reading = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, scope]);

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

  /* A picture dropped on an entry — a tile from anywhere, or a file from the device — becomes its reference image. */
  const [dropOver, setDropOver] = useState<string | null>(null);
  const dropOn = (entry: CastEntry, e: React.DragEvent) => {
    e.preventDefault(); setDropOver(null);
    const { ids, files } = readDrop(e.dataTransfer, p.assets);
    const file = files.find((f) => f.type.startsWith("image/"));
    if (file) { void uploadReference(entry, file); return; }
    if (files.length) { setErrors((x) => ({ ...x, [entry.id]: "A reference is a picture; the other files are not used here." })); return; }
    const lib = ids.map((id) => items.find((x) => x.take.id === id)).find(Boolean);
    if (!lib) { if (ids.length) setErrors((x) => ({ ...x, [entry.id]: "That asset is not in this project's Library." })); return; }
    if (lib.media !== "image" || !lib.url) { setErrors((x) => ({ ...x, [entry.id]: "A reference is a picture." })); return; }
    const asset = entryAsset(lib);
    editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
    setEntry(entry.id, (x) => ({ ...x, referenceAssetId: asset.id }));
    void editor.ensureSaved();
  };

  /* Attached to an entry's description or prompt: the first picture becomes its reference image. */
  const attachToEntry = (entry: CastEntry) => async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const picture = media.find((m) => m.kind === "image");
    const kept = [...unreadable, ...media.filter((m) => m !== picture).map((m) => m.name)];
    if (picture) {
      const known = p.assets.find((a) => a.id === picture.id || a.generationId === picture.id || a.uploadId === picture.id);
      const asset = known ?? attachedAsset(picture, "Reference", `Reference for ${entry.name}`);
      editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
      setEntry(entry.id, (x) => ({ ...x, referenceAssetId: asset.id }));
      await editor.ensureSaved();
    }
    return [picture ? `${picture.name} is the reference for ${entry.name || "this entry"}.` : "", keptNote(kept, "an entry takes one reference picture.") ?? ""].filter(Boolean).join(" ") || null;
  };

  const fromBeats = useMemo(() => castFromBeats(p.production?.beats, cast.entries), [p.production?.beats, cast.entries]);
  /* What the button counted, less what is listed by the time the click lands — decided on the list as it is then, not as
     this render saw it: the agent's cast may have landed in between, and a name is never listed twice. None left: no edit. */
  const addFromBeats = () => {
    const sheet = p.production?.beats, counted = new Set(fromBeats.map((e) => e.id));
    setCast((c) => {
      const missing = castFromBeats(sheet, c.entries).filter((e) => counted.has(e.id));
      return missing.length ? { ...c, entries: [...c.entries, ...missing].slice(0, CAST_LIMITS.entries) } : c;
    });
    void editor.ensureSaved();
  };
  const agentModel = agent.model;
  const q = runs.quote && runs.quote.input.model === agentModel?.id && runs.quote.input.effort === agent.effort && runs.quote.input.kind === "cast" ? runs.quote : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : activeCast ? "The agent is working." : !agentModel ? "Choose an agent above." : !p.production?.beats?.scenes.length && !(p.script ?? "").trim() ? "Write the script or break it into beats first." : null;
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

      <section className="gx-gen-card" aria-label="Cast list" data-testid="cast-list" data-section="list">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Cast & elements</span>
          <span className="gx-spacer" />
          <span className="gx-hint" data-testid="cast-counts">{characters} characters · {cast.entries.length - characters} elements</span>
        </div>
        <p className="gx-hint">Start from the beat sheet’s characters and props, or have the agent cast the film. Any entry’s still is made in Gen.</p>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" disabled={!fromBeats.length} title={!p.production?.beats ? "Break the script into beats first." : undefined} onClick={addFromBeats} data-testid="cast-from-beats">
            {p.production?.beats ? `Add ${fromBeats.length} from the beat sheet` : "Add from the beat sheet"}
          </button>
          {!p.production?.beats ? <button type="button" className="gx-hbtn" onClick={onBeats}>Open Beats</button> : null}
          <button type="button" className="gx-hbtn" onClick={() => setCast((c) => ({ ...c, entries: [...c.entries, newEntry("character")].slice(0, CAST_LIMITS.entries) }))} data-testid="cast-add-character">+ Character</button>
          <button type="button" className="gx-hbtn" onClick={() => setCast((c) => ({ ...c, entries: [...c.entries, newEntry("element")].slice(0, CAST_LIMITS.entries) }))} data-testid="cast-add-element">+ Element</button>
        </div>
        {activeCast ? <p className="gx-hint" role="status">{agentLabel(agentFamilyOf(activeCast.model) ?? "claude")} is casting · step {Math.min(activeCast.completedSteps + 1, activeCast.totalSteps)} of {activeCast.totalSteps}</p> : null}
        <AgentAction id="cast-agent" secondary estimateLabel="Have the agent cast the film" startLabel={(price) => `Cast it · up to ${price}`} quote={q} busy={runs.busy} blocked={blocked}
          describe={(qq, price) => `${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${price}`}
          onEstimate={() => void runs.estimate({ kind: "cast", model: agentModel!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
      </section>

      <section className="pd-frames" aria-label="Cast and elements" data-testid="cast-entries" data-section="entries">
        {cast.entries.map((entry) => {
          const shown = entry.selected ?? entry.takes[0]?.genId;
          const reference = entry.referenceAssetId ? p.assets.find((a) => a.id === entry.referenceAssetId) : undefined;
          const inFlight = (entry.pending ?? []).length > 0;
          /* Built earlier with a stills model that made something Cast no longer does: shown, never changed. */
          if (retiredModelOf(entry)) return <RetiredEntry key={entry.id} entry={entry} aspect={p.aspect} onStill={() => openGenOn(shell, { prompt: castStillPrompt(entry), type: "image", note: `Reference still · ${entry.name.trim() || (entry.kind === "character" ? "Character" : "Element")}` })} />;
          const character = entry.kind === "character";
          /* Its identity: one built here and ready, or the earlier one its saved draft names (listed, read only). */
          const identity = entry.identityId ? ready.find((i) => i.id === entry.identityId) ?? null : null;
          const kept = entry.identityId && !identity ? earlier?.find((i) => i.id === entry.identityId) ?? null : null;
          return (
            <article key={entry.id} className="gx-gen-card pd-frame" data-testid="cast-entry" data-kind={entry.kind} aria-label={entry.name || "Unnamed"} data-drop={dropOver === entry.id || undefined}
              onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(entry.id); } }}
              onDragLeave={() => setDropOver((v) => (v === entry.id ? null : v))} onDrop={(e) => dropOn(entry, e)}>
              <div className="pd-frame-image" data-ratio={character ? "4:5" : p.aspect}>
                {shown ? <LazyMedia url={`/api/media/${shown}`} kind="image" alt={entry.name} className="gx-lazy" /> : <span className="gx-hint">{inFlight ? "Rendering…" : "Not rendered yet"}</span>}
                {inFlight && shown ? <span className="gx-badge gx-badge--new">Rendering</span> : null}
              </div>
              <div className="pd-row-head">
                <input className="gx-field pd-cast-name" aria-label="Name" value={entry.name} maxLength={CAST_LIMITS.name} placeholder={character ? "Character name" : "Element name"} onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, name: v })); }} />
                <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label={`${entry.name || "Entry"} kind`}>
                  {(["character", "element"] as const).map((k) => <button key={k} type="button" role="radio" className="gx-seg-btn" aria-checked={entry.kind === k} onClick={() => setEntry(entry.id, (x) => ({ ...x, kind: k }))}><span>{k === "character" ? "Cast" : "Element"}</span></button>)}
                </div>
              </div>
              <PromptAttach scope={scope} projectId={p.id} onAttach={attachToEntry(entry)} testId="cast-description-attach"><textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Entry"} description`} value={entry.description} maxLength={CAST_LIMITS.description} placeholder="Who or what it is, where it appears" onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, description: v })); }} /></PromptAttach>
              {!character ? (
                <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label={`${entry.name || "Element"} category`}>
                  {(["environment", "prop"] as const).map((c) => <button key={c} type="button" role="radio" className="gx-seg-btn" aria-checked={entryCategory(entry) === c} onClick={() => setEntry(entry.id, (x) => ({ ...x, category: c }))}><span>{c === "environment" ? "Environment" : "Prop"}</span></button>)}
                </div>
              ) : null}
              <PromptAttach scope={scope} projectId={p.id} onAttach={attachToEntry(entry)} testId="cast-prompt-attach"><textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Entry"} prompt`} value={entry.prompt} maxLength={CAST_LIMITS.prompt} placeholder="What its still should show" onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, prompt: v })); }} data-testid="cast-prompt" /></PromptAttach>
              <div className="pd-row-head">
                <label className="gx-hbtn pd-upload">
                  {working[entry.id] || (reference ? "Replace reference" : "Reference image")}
                  <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Upload a reference image for ${entry.name || "this entry"}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadReference(entry, f); }} />
                </label>
                {reference ? <span className="pd-ref-chip" {...previewAttrs(assetPreview(reference))} data-testid="cast-reference"><span className="gx-ref-thumb"><LazyMedia url={assetPreview(reference)!.url} kind="image" alt="" name={reference.name} preview={false} className="gx-lazy" /></span><span className="gx-hint">{reference.name}</span></span> : null}
              </div>
              {entry.takes.length > 1 ? (
                <div className="pd-takes" role="radiogroup" aria-label={`${entry.name} stills`}>
                  {entry.takes.map((take, i) => <button key={take.genId} type="button" role="radio" aria-checked={take.genId === shown} aria-label={`Still ${entry.takes.length - i}`} onClick={() => setEntry(entry.id, (x) => ({ ...x, selected: take.genId }))}><LazyMedia url={`/api/media/${take.genId}`} kind="image" alt="" className="gx-lazy" /></button>)}
                </div>
              ) : null}
              {character ? (
                <div className="pd-cast-render" data-testid="cast-render">
                  <label className="pd-soul"><span className="gx-hint">Identity</span>
                    <select aria-label={`${entry.name || "Character"} identity`} value={identity?.id ?? kept?.id ?? ""} onChange={(e) => { const v = e.target.value; setEntry(entry.id, (x) => ({ ...x, identityId: v || undefined })); }} data-testid="cast-identity">
                      <option value="">None</option>
                      {ready.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      {kept ? <option value={kept.id} disabled>{kept.name} · earlier</option> : null}
                    </select>
                  </label>
                </div>
              ) : null}
              <div className="gx-gen-enhance">
                {/* A character with no identity built here: its primary opens Build identity below, at the trainer's price. */}
                {character && !identity ? (
                  <button type="button" className="gx-primary pd-go" onClick={() => buildFor(entry)} data-testid="cast-build-identity">
                    {price ? `Build identity · ${price.text}` : "Build identity"}
                  </button>
                ) : null}
                <button type="button" className="gx-hbtn" disabled={!castStillPrompt(entry)} aria-describedby={castStillPrompt(entry) ? undefined : `cast-still-why-${entry.id}`} data-testid="cast-still-gen"
                  onClick={() => openGenOn(shell, { prompt: castStillPrompt(entry), type: "image", note: `Reference still · ${entry.name.trim() || (character ? "Character" : "Element")}` })}>Make a still in Gen</button>
                <button type="button" className="gx-hbtn" aria-label={`Remove ${entry.name || "this entry"}`} onClick={() => setCast((c) => ({ ...c, entries: c.entries.filter((x) => x.id !== entry.id) }))}>Remove</button>
              </div>
              {!castStillPrompt(entry) ? <span className="gx-reason" id={`cast-still-why-${entry.id}`} data-testid="cast-still-why">Name it or write its prompt first.</span> : null}
              {entry.job?.status === "submitted" ? <span className="gx-hint" data-testid="cast-earlier-build">A build sent earlier lands in the Library when it finishes.</span> : null}
              {errors[entry.id] ? <p className="gx-gen-error" role="alert" data-testid="cast-error">{errors[entry.id]}</p> : null}
            </article>
          );
        })}
        {!cast.entries.length ? <p className="gx-empty">No cast yet. Add from the beat sheet, let the agent cast the film, or add one by hand.</p> : null}
      </section>

      <CastIdentities scope={scope} projectId={p.id} items={items} save={editor.ensureSaved} built={built} earlier={earlier ?? []} seed={seed} />
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}{editor.notice ? ` · ${editor.notice}` : ""}</p>
    </div>
  );
}

/**
 * An entry built earlier with a stills model that made something Cast no
 * longer does (lib/production/cast.ts › retiredModelOf): shown, never
 * changed. Its stills stay in the Library; a new still can be made in Gen.
 */
function RetiredEntry({ entry, aspect, onStill }: { entry: CastEntry; aspect: string; onStill: () => void }) {
  const shown = entry.selected ?? entry.takes[0]?.genId;
  const character = entry.kind === "character";
  return (
    <article className="gx-gen-card pd-frame" data-testid="cast-entry" data-kind={entry.kind} data-readonly="" aria-label={entry.name || "Unnamed"}>
      <div className="pd-frame-image" data-ratio={character ? "4:5" : aspect}>
        {shown ? <LazyMedia url={`/api/media/${shown}`} kind="image" alt={entry.name} className="gx-lazy" /> : <span className="gx-hint">Not rendered</span>}
      </div>
      <div className="pd-row-head">
        <input className="gx-field pd-cast-name" aria-label="Name" value={entry.name} readOnly />
        <span className="gx-chip gx-chip--static">{character ? "Cast" : "Element"}</span>
      </div>
      {entry.description ? <p className="gx-hint pd-frame-desc">{entry.description}</p> : null}
      <textarea className="gx-textarea pd-small" aria-label={`${entry.name || "Entry"} prompt`} value={entry.prompt} readOnly data-testid="cast-prompt" />
      <p className="gx-hint" data-testid="cast-retired">Built earlier on an engine that is no longer offered. Read-only: {entry.takes.length ? `its ${entry.takes.length === 1 ? "still stays" : `${entry.takes.length} stills stay`} in the Library.` : "nothing of it is changed."}</p>
      <div className="gx-gen-enhance">
        <button type="button" className="gx-hbtn" disabled={!castStillPrompt(entry)} onClick={onStill} data-testid="cast-still-gen">Make a still in Gen</button>
      </div>
    </article>
  );
}
