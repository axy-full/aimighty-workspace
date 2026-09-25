"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { dragAttrs } from "@/lib/drop";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { BOARD_MODELS, stillShape, type BoardModel } from "@/lib/production/boards";
import { getModel } from "@/lib/models";
import { addTakeToCut, entryAsset } from "@/lib/production/sequence";
import { sendToRig } from "@/lib/production/rig-build";
import { useShell } from "@/lib/shell/state";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { refreshProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { SeedanceEditHost } from "../tools/SeedanceEditHost";
import { TranscribePanel } from "./TranscribePanel";
import { useStageFacts } from "./use-stage-facts";
import type { Project } from "@/lib/workbench/studio";

const EDIT_LIMIT = 4000;
const CATEGORY_GROUP: Record<string, string> = { Character: "Characters", Element: "Elements", Environment: "Elements", Prop: "Elements", Look: "Elements", Storyboard: "Storyboard frames", "Line drawing": "Line drawings", Sketch: "Line drawings", Astra: "3D (Astra)", Screenplay: "Scripts", "Ad-film script": "Scripts" };
const MEDIA_GROUP: Record<string, string> = { video: "Videos", image: "Images", audio: "Audio" };
const GROUP_ORDER = ["Videos", "Images", "Audio", "Characters", "Elements", "Storyboard frames", "Line drawings", "3D (Astra)", "Scripts", "Documents & other files"];

/** Every library entry in one group: the category the project filed it under, else its kind. */
export function assetGroups(items: readonly LibraryEntry[], project: Project | null): { label: string; items: LibraryEntry[] }[] {
  const category = new Map<string, string>();
  for (const a of project?.assets ?? []) for (const id of [a.id, a.generationId, a.uploadId]) if (id && CATEGORY_GROUP[a.category]) category.set(id, CATEGORY_GROUP[a.category]);
  const out = new Map<string, LibraryEntry[]>();
  for (const e of items) {
    const label = category.get(e.take.sourceId) ?? (e.media ? MEDIA_GROUP[e.media] : undefined) ?? "Documents & other files";
    out.set(label, [...(out.get(label) ?? []), e]);
  }
  return GROUP_ORDER.filter((g) => out.has(g)).map((label) => ({ label, items: out.get(label)! }));
}
type Generation = { id: string; status: string; error?: string | null };

/** The re-edit request for a still: the take as the reference, the instruction, and the order to change nothing else. */
export function reEditRequest(entry: LibraryEntry, instruction: string, model: BoardModel, productionProjectId: string, ratio: string, extras: ({ genId: string } | { uploadId: string })[] = []): GenerationBodyInput {
  const source = entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId };
  return {
    prompt: `Edit the reference image: ${instruction.trim()}\n\nChange only what is asked. Keep the composition, framing, lighting, people and every other detail exactly as they are.${extras.length ? ` The first image is the one to edit; the ${extras.length === 1 ? "other image shows" : `other ${extras.length} images show`} what to bring into it.` : ""}`.slice(0, 10_000),
    kind: "image", model: { id: model }, mapping: { shotId: "", productionProjectId }, ...stillShape(getModel(model), ratio), duration: 5,
    references: [{ ...source, role: "reference_image" }, ...extras.map((x) => ({ ...x, role: "reference_image" as const }))], firstFrameAssetId: "",
  };
}

/**
 * Production › Edit (owner's brief, 23 September): every take of the project;
 * a video take opens in Seedance Edit (2.5, or 2.0) on that clip; a still is
 * re-edited from an instruction with the take as its reference, priced before
 * it renders; any take goes to the Timeline in one press.
 */
export function EditStage({ scope, projectId, items, onTimeline }: { scope: string; projectId: string; items: LibraryEntry[]; onTimeline: () => void }) {
  const draft = useDraftEditor(scope, projectId);
  const { toast, state } = useWorkspace();
  const shell = useShell();
  const project = draft.project;
  useStageFacts("takes", project);
  /* Every generation first; then every asset, each in one group — its production category, else its kind. */
  const generations = useMemo(() => items.filter((e) => e.asset.origin === "generation"), [items]);
  const groups = useMemo(() => assetGroups(items, project), [items, project]);
  /* A take sent here (Viral's Send to Edit, the Library) opens first. */
  const [picked, setPicked] = useState<string | null>(() => (state.selKind === "take" ? state.selId : null));
  const editable = (e: LibraryEntry) => (e.media === "video" || e.media === "image") && Boolean(e.url);
  const entry = items.find((e) => e.take.id === picked && editable(e)) ?? generations.find(editable) ?? null;
  const pick = (e: LibraryEntry) => {
    if (!editable(e)) { toast(e.media === "audio" ? "Sound goes on the lanes in Edit & Sound." : "This file has no picture to edit."); return; }
    setPicked(e.take.id); setQuote(null); setError("");
    requestAnimationFrame(() => document.querySelector("[data-section='edit-panel']")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState<BoardModel>(BOARD_MODELS[0].id);
  const [quote, setQuote] = useState<{ key: string; credits: number } | null>(null);
  /* Pictures attached to the instruction ride as further references: what to bring into the still. */
  const [extras, setExtras] = useState<{ id: string; name: string; ref: { genId: string } | { uploadId: string } }[]>([]);
  const attachToEdit = async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const pictures = media.filter((m) => m.kind === "image").slice(0, 3);
    setExtras((prev) => [...prev, ...pictures.filter((m) => !prev.some((x) => x.id === m.key)).map((m) => ({ id: m.key, name: m.name, ref: m.origin === "generation" ? { genId: m.id } : { uploadId: m.id } }))].slice(0, 3));
    setQuote(null);
    return [pictures.length ? `${pictures.map((m) => m.name).join(", ")} ${pictures.length === 1 ? "goes" : "go"} with the edit as ${pictures.length === 1 ? "a reference" : "references"}.` : "", keptNote([...unreadable, ...media.filter((m) => !pictures.includes(m)).map((m) => m.name)], "an edit takes up to three reference pictures.") ?? ""].filter(Boolean).join(" ") || null;
  };
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ jobId: string; from: string } | null>(null);
  const [made, setMade] = useState<{ genId: string; from: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /* A re-edit in flight: read until it lands, then the Library shows it. */
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(pending.jobId)}`, { headers: { "X-Workbench-Scope": scope } }).then(({ generation }) => {
        if (!alive.current || !["succeeded", "failed", "cancelled"].includes(generation.status)) return;
        setPending(null);
        if (generation.status === "succeeded") { setMade({ genId: generation.id, from: pending.from }); void refreshProjectLibrary(scope, projectId); toast("The re-edit is in the library"); }
        else setError(generation.error || "The re-edit did not render. A failed render is not billed.");
      }).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [pending, scope, projectId, toast]);

  if (!project) return <p className="gx-empty" role="status">{draft.state.error ?? "Opening the takes…"}</p>;
  const key = entry ? JSON.stringify([entry.take.id, instruction.trim(), model, project.aspect, extras.map((x) => x.id)]) : "";
  const shown = quote && quote.key === key ? quote : null;
  const request = () => reEditRequest(entry!, instruction, model, project.productionProjectId!, project.aspect, extras.map((x) => x.ref));
  const price = async () => {
    setBusy("Pricing…"); setError("");
    try {
      const fresh = await studioRequest<{ estimatedCredits: number }>("/api/generate/quote", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify(generationRequestBody(request())) });
      setQuote({ key, credits: fresh.estimatedCredits });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This re-edit could not be priced."); }
    finally { setBusy(""); }
  };
  const render = async () => {
    if (!shown || !entry) return;
    setBusy("Sending…"); setError("");
    try {
      const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, project.id, `reedit-${entry.take.sourceId}`), shown: shown.credits, request: { endpoint: "/api/generate", input: request() } });
      if (outcome.state === "repriced") { setQuote({ key, credits: outcome.credits }); setError(outcome.reason); return; }
      if (outcome.state === "refused") { setError(outcome.reason); return; }
      setQuote(null); setPending({ jobId: outcome.jobId, from: entry.take.id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The re-edit could not be sent."); }
    finally { setBusy(""); }
  };
  const toTimeline = (e: LibraryEntry) => {
    try { draft.onChange((p) => addTakeToCut(p, e)); void draft.ensureSaved(); toast(`${e.take.name} is in the cut`); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "It could not go on the timeline."); }
  };
  const sourceKey = entry ? `${entry.asset.origin === "generation" ? "generation" : "upload"}:${entry.take.sourceId}` : null;
  const blocked = !entry ? "Choose a take." : !project.productionProjectId ? "Save the project first." : !instruction.trim() ? "Write what should change." : null;

  return (
    <div className="pd-stage gx-enter" data-testid="edit-stage">
      <section className="gx-gen-card" aria-label="Generations" data-testid="edit-takes" data-section="takes">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Generations</span>
          <span className="gx-spacer" />
          <span className="gx-hint">{generations.length} made in this project · {project.shots.length} in the cut</span>
        </div>
        {generations.length ? (
          <div className="pd-take-grid" role="radiogroup" aria-label="Generations">
            {generations.map((e: LibraryEntry) => (
              <button key={e.take.id} type="button" role="radio" aria-checked={entry?.take.id === e.take.id} className="pd-take" onClick={() => pick(e)} data-testid="edit-take" data-media={e.media ?? "file"} {...previewAttrs(entryPreview(e))} {...dragAttrs(e.take.id, { name: e.take.name, kind: e.media ?? "file" })}>
                {e.url && (e.media === "image" || e.media === "video") ? <LazyMedia url={e.url} kind={e.media} alt="" name={e.take.name} className="gx-lazy" /> : <span className="pd-take-file" aria-hidden="true">{e.media === "audio" ? "♪" : "▤"}</span>}
                <span className="gx-badge">{(e.media ?? "file").toUpperCase()}</span>
                <span className="pd-take-name">{e.take.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="gx-empty">Nothing generated yet. Frames from Storyboards, builds from Cast and shots from the Rig all land here.</p>}
      </section>

      {entry ? (
        <>
          <div className="pd-row-head" data-section="edit-panel"><span className="gx-eyebrow" data-functional-label="">Selected · {entry.take.name}</span></div>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-hbtn" onClick={() => toTimeline(entry)} data-testid="edit-to-timeline">Add to the cut</button>
            <button type="button" className="gx-hbtn" onClick={() => { sendToRig({ projectId: project.id, asset: entryAsset(entry) }); shell.goSuite("studio", "rig"); }} data-testid="edit-to-rig">Build a rig from this take</button>
            <button type="button" className="gx-hbtn" onClick={onTimeline}>Open Edit & Sound ›</button>
          </div>
          {entry.media === "video" || entry.media === "audio" ? (
            <TranscribePanel key={entry.take.id} scope={scope} name={entry.take.name} projectId={project.productionProjectId}
              source={entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId }} />
          ) : null}
          {entry.media === "audio" ? null : entry.media === "video" ? (
            <div data-section="video"><SeedanceEditHost scope={scope} project={project} initialSource={sourceKey} onBack={() => setPicked(null)} /></div>
          ) : (
            <section className="gx-gen-card gx-workflow" aria-label="Re-edit the image" data-testid="edit-image" data-section="image">
              <div className="gx-gen-row">
                <span className="gx-eyebrow" data-functional-label="">Re-edit · this workspace’s credits</span>
                <h2 className="gx-workflow-title">Change something in this still</h2>
                <p className="gx-hint">The take is the reference; only what you ask for changes. The result is a new take — the original stays.</p>
              </div>
              <PromptAttach scope={scope} projectId={projectId} onAttach={attachToEdit} testId="edit-attach"><textarea className="gx-textarea pd-small" aria-label="What should change" maxLength={EDIT_LIMIT} value={instruction} placeholder="Make it night, add rain on the glass, turn her head towards camera…" onChange={(e) => setInstruction(e.target.value)} data-testid="edit-instruction" />{extras.length ? <div className="pa-chips" data-testid="edit-extras">{extras.map((x) => <span key={x.id} className="pa-chip" {...previewAttrs({ url: "genId" in x.ref ? `/api/media/${x.ref.genId}` : `/api/uploads/${x.ref.uploadId}`, kind: "image", name: x.name })}><span className="pa-chip-name">{x.name}</span><button type="button" aria-label={`Remove ${x.name}`} onClick={() => { setExtras((prev) => prev.filter((y) => y.id !== x.id)); setQuote(null); }}>×</button></span>)}</div> : null}</PromptAttach>
              <div className="pd-row-head">
                <span className="gx-hint">Engine</span>
                <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Re-edit engine">
                  {BOARD_MODELS.map((m) => <button key={m.id} type="button" role="radio" className="gx-seg-btn" aria-checked={model === m.id} onClick={() => setModel(m.id)}><span>{m.label}</span></button>)}
                </div>
              </div>
              <div className="gx-gen-enhance">
                {shown ? (
                  <>
                    <button type="button" className="gx-primary" disabled={Boolean(busy)} onClick={() => void render()} data-testid="edit-render">{busy || `Re-edit · ${shown.credits.toLocaleString()} credits`}</button>
                    <button type="button" className="gx-hbtn" onClick={() => setQuote(null)}>Change</button>
                  </>
                ) : (
                  <button type="button" className="gx-primary" disabled={Boolean(busy) || Boolean(blocked) || Boolean(pending)} onClick={() => void price()} data-testid="edit-price">{busy || (pending ? "Rendering…" : "Price the re-edit")}</button>
                )}
                {blocked && !shown ? <span className="gx-reason" data-testid="edit-blocked">{blocked}</span> : null}
              </div>
              {made && made.from === entry.take.id ? (
                <div className="pd-sketch" data-testid="edit-result">
                  <LazyMedia url={`/api/media/${made.genId}`} kind="image" alt="The re-edit" className="gx-lazy" />
                  <span className="gx-hint">The re-edit is a new take in the library.</span>
                </div>
              ) : null}
              {error ? <p className="gx-gen-error" role="alert">{error}</p> : null}
            </section>
          )}
        </>
      ) : null}
      <section className="gx-gen-card" aria-label="All assets" data-testid="takes-assets" data-section="assets">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">All assets</span>
          <span className="gx-spacer" />
          <span className="gx-hint">{items.length} in this project</span>
        </div>
        {groups.length ? groups.map((group) => (
          <div key={group.label} className="pd-asset-group" data-testid="asset-group" data-group={group.label}>
            <div className="pd-row-head"><span className="pd-asset-group-name">{group.label}</span><span className="gx-hint">{group.items.length}</span></div>
            <div className="pd-take-grid" role="radiogroup" aria-label={group.label}>
              {group.items.map((e: LibraryEntry) => (
              <button key={e.take.id} type="button" role="radio" aria-checked={entry?.take.id === e.take.id} className="pd-take" onClick={() => pick(e)} data-testid="edit-take" data-media={e.media ?? "file"} {...previewAttrs(entryPreview(e))} {...dragAttrs(e.take.id, { name: e.take.name, kind: e.media ?? "file" })}>
                {e.url && (e.media === "image" || e.media === "video") ? <LazyMedia url={e.url} kind={e.media} alt="" name={e.take.name} className="gx-lazy" /> : <span className="pd-take-file" aria-hidden="true">{e.media === "audio" ? "♪" : "▤"}</span>}
                <span className="gx-badge">{(e.media ?? "file").toUpperCase()}</span>
                <span className="pd-take-name">{e.take.name}</span>
              </button>
            ))}
            </div>
          </div>
        )) : <p className="gx-empty">No assets yet.</p>}
      </section>
    </div>
  );
}
