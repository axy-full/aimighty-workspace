"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { BOARD_MODELS, type BoardModel } from "@/lib/production/boards";
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
import { useStageFacts } from "./use-stage-facts";

const EDIT_LIMIT = 4000;
type Generation = { id: string; status: string; error?: string | null };

/** The re-edit request for a still: the take as the reference, the instruction, and the order to change nothing else. */
export function reEditRequest(entry: LibraryEntry, instruction: string, model: BoardModel, productionProjectId: string, ratio: string): GenerationBodyInput {
  const source = entry.asset.origin === "generation" ? { genId: entry.take.sourceId } : { uploadId: entry.take.sourceId };
  return {
    prompt: `Edit the reference image: ${instruction.trim()}\n\nChange only what is asked. Keep the composition, framing, lighting, people and every other detail exactly as they are.`.slice(0, 10_000),
    kind: "image", model: { id: model }, mapping: { shotId: "", productionProjectId }, ratio, resolution: "1K", duration: 5,
    references: [{ ...source, role: "reference_image" }], firstFrameAssetId: "",
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
  const takes = useMemo(() => items.filter((e) => (e.media === "video" || e.media === "image") && e.url), [items]);
  /* A take sent here (Viral's Send to Edit, the Library) opens first. */
  const [picked, setPicked] = useState<string | null>(() => (state.selKind === "take" ? state.selId : null));
  const entry = takes.find((e) => e.take.id === picked) ?? takes[0] ?? null;
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState<BoardModel>(BOARD_MODELS[0].id);
  const [quote, setQuote] = useState<{ key: string; credits: number } | null>(null);
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
  const key = entry ? JSON.stringify([entry.take.id, instruction.trim(), model, project.aspect]) : "";
  const shown = quote && quote.key === key ? quote : null;
  const request = () => reEditRequest(entry!, instruction, model, project.productionProjectId!, project.aspect);
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
    try { draft.onChange((p) => addTakeToCut(p, e)); void draft.ensureSaved(); toast(`${e.take.name} is on the timeline`); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "It could not go on the timeline."); }
  };
  const sourceKey = entry ? `${entry.asset.origin === "generation" ? "generation" : "upload"}:${entry.take.sourceId}` : null;
  const blocked = !entry ? "Choose a take." : !project.productionProjectId ? "Save the project first." : !instruction.trim() ? "Write what should change." : null;

  return (
    <div className="pd-stage gx-enter" data-testid="edit-stage">
      <section className="gx-gen-card" aria-label="Takes" data-testid="edit-takes" data-section="takes">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Takes</span>
          <span className="gx-spacer" />
          <span className="gx-hint">{takes.length} in this project · {project.shots.length} on the timeline</span>
        </div>
        {takes.length ? (
          <div className="pd-take-grid" role="radiogroup" aria-label="Choose a take to edit">
            {takes.map((e) => (
              <button key={e.take.id} type="button" role="radio" aria-checked={entry?.take.id === e.take.id} className="pd-take" onClick={() => { setPicked(e.take.id); setQuote(null); setError(""); }} data-testid="edit-take" data-media={e.media}>
                <LazyMedia url={e.url!} kind={e.media === "video" ? "video" : "image"} alt="" className="gx-lazy" />
                <span className="gx-badge">{e.media === "video" ? "VIDEO" : "IMAGE"}</span>
                <span className="pd-take-name">{e.take.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="gx-empty">No takes yet. Generate frames in Storyboards, builds in Cast, or shots in Rig — they all land here.</p>}
      </section>

      {entry ? (
        <>
          <div className="gx-gen-enhance">
            <button type="button" className="gx-hbtn" onClick={() => toTimeline(entry)} data-testid="edit-to-timeline">Add “{entry.take.name}” to the timeline</button>
            <button type="button" className="gx-hbtn" onClick={() => { sendToRig({ projectId: project.id, asset: entryAsset(entry) }); shell.goSuite("studio", "rig"); }} data-testid="edit-to-rig">Build a rig from this take</button>
            <button type="button" className="gx-hbtn" onClick={onTimeline}>Open the Timeline ›</button>
          </div>
          {entry.media === "video" ? (
            <div data-section="video"><SeedanceEditHost scope={scope} project={project} initialSource={sourceKey} onBack={() => setPicked(null)} /></div>
          ) : (
            <section className="gx-gen-card gx-workflow" aria-label="Re-edit the image" data-testid="edit-image" data-section="image">
              <div className="gx-gen-row">
                <span className="gx-eyebrow" data-functional-label="">Re-edit · this workspace’s credits</span>
                <h2 className="gx-workflow-title">Change something in this still</h2>
                <p className="gx-hint">The take is the reference; only what you ask for changes. The result is a new take — the original stays.</p>
              </div>
              <textarea className="gx-textarea pd-small" aria-label="What should change" maxLength={EDIT_LIMIT} value={instruction} placeholder="Make it night, add rain on the glass, turn her head towards camera…" onChange={(e) => setInstruction(e.target.value)} data-testid="edit-instruction" />
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
    </div>
  );
}
