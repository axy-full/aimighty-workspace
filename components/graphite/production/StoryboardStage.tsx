"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { failureLine } from "@/lib/errors";
import type { TakeFailure } from "@/lib/providerOutcome";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { BOARD_MODELS, BOARD_STYLES, deleteDrawing, DEFAULT_BOARDS, FRAME_PROMPT_LIMIT, boardShots, emptyFrame, frameRequest, shotPrompt, type BoardFrame, type Boards, type NumberedShot } from "@/lib/production/boards";
import { generationRequestBody } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import type { Asset } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { dispatchGeneration } from "@/lib/workspace/generate-submit";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { refreshProjectLibrary } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { AgentAction } from "./AgentAction";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";

type Generation = { id: string; status: string; error?: string | null; failure?: TakeFailure | null };
const DONE = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Production › Storyboards (owner's brief, 23 September): every beat-sheet shot
 * is a frame with a prompt button; the agent writes the prompts; frames render
 * as live action, coloured sketch or black-and-white sketch; a rough drawing
 * uploaded for a shot is read by the agent and the frame keeps its blocking.
 */
export function StoryboardStage({ projectId, scope, onBeats, onRig }: { projectId: string; scope: string; onBeats: () => void; onRig?: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the storyboards" /></div>;
  return <BoardsBody editor={editor} scope={scope} onBeats={onBeats} onRig={onRig} />;
}

function BoardsBody({ editor, scope, onBeats, onRig }: { editor: ReturnType<typeof useDraftEditor>; scope: string; onBeats: () => void; onRig?: () => void }) {
  const p = editor.project!;
  const { toast } = useWorkspace();
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  const agent = useAgentChoice(runs.models);
  useStageFacts("boards", p);
  const boards = p.production?.boards ?? DEFAULT_BOARDS;
  const shots = useMemo(() => boardShots(p.production?.beats), [p.production?.beats]);
  const frameOf = (id: string) => boards.frames[id] ?? emptyFrame();
  const [open, setOpen] = useState<string | null>(null);
  const [working, setWorking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [batchWorking, setBatchWorking] = useState(false);
  /* Frames picked to storyboard together; fresh prompts being written to revise a frame; a drawing about to be deleted. */
  const [picked, setPicked] = useState<string[]>([]);
  const [revising, setRevising] = useState<Record<string, string>>({});
  const [dropping, setDropping] = useState<string | null>(null);
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  /* An update that hands back what it was given changes nothing: no edit, no save. */
  const setBoards = useCallback((fn: (b: Boards) => Boards) => editor.change((old) => {
    const was = old.production?.boards ?? DEFAULT_BOARDS, next = fn(was);
    return next === was ? old : { ...old, production: { ...old.production, boards: next } };
  }), [editor]);
  const setFrame = useCallback((id: string, fn: (f: BoardFrame) => BoardFrame) => setBoards((b) => {
    const was = b.frames[id], next = fn(was ?? emptyFrame());
    return next === was ? b : { ...b, frames: { ...b.frames, [id]: next } };
  }), [setBoards]);

  /* ── The agent's prompt run: fills every frame the director has not written, keeps the ones they did. ── */
  const allPromptRuns = runs.jobs.filter((job) => job.kind === "frames");
  const promptRuns = allPromptRuns.filter((job) => !job.shotId);
  const framePromptRuns = allPromptRuns.filter((job) => job.shotId);
  const sketchRuns = runs.jobs.filter((job) => job.kind === "sketch");
  const activePrompts = allPromptRuns.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const activeSketch = sketchRuns.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const taking = useRef(new Set<string>());
  useEffect(() => {
    const done = promptRuns.find((job) => job.status === "succeeded");
    if (!done || boards.promptsJobId === done.id || taking.current.has(done.id)) return;
    taking.current.add(done.id);
    void (async () => {
      try {
        const prompts: { shotId: string; prompt: string }[] = [];
        for (let offset = 0; offset < (done.resultPage?.totalChunks ?? 1); offset++) prompts.push(...((offset === 0 && done.result ? done : await runs.load(done.id, offset)).result?.frames ?? []));
        let kept = 0;
        setBoards((b) => {
          const frames = { ...b.frames };
          for (const { shotId, prompt } of prompts) {
            const shot = shots.find((s) => s.id === shotId);
            const current = frames[shotId] ?? emptyFrame();
            if (current.prompt.trim() && (!shot || current.prompt !== shotPrompt(shot))) { kept++; continue; }
            frames[shotId] = { ...current, prompt: prompt.slice(0, FRAME_PROMPT_LIMIT) };
          }
          return { ...b, frames, promptsJobId: done.id };
        });
        if (await editor.ensureSaved()) toast(`The agent wrote ${prompts.length - kept} frame prompts${kept ? ` · kept ${kept} you wrote` : ""}`);
      } catch (error) { runs.setError(error instanceof Error ? error.message : "The prompts could not be read."); }
      finally { taking.current.delete(done.id); }
    })();
  }, [promptRuns, boards.promptsJobId, runs, setBoards, shots, editor, toast]);
  /* A frame's own "Prompt with the agent": the newest one for that shot replaces its prompt, once. */
  useEffect(() => {
    for (const job of framePromptRuns) {
      const written = job.result?.frames?.[0];
      if (job.status !== "succeeded" || !written || !job.shotId || taking.current.has(job.id)) continue;
      if (framePromptRuns.find((j) => j.shotId === job.shotId && j.status === "succeeded") !== job || boards.frames[job.shotId]?.promptJobId === job.id) continue;
      taking.current.add(job.id);
      setFrame(job.shotId, (f) => ({ ...f, prompt: written.prompt.slice(0, FRAME_PROMPT_LIMIT), promptJobId: job.id }));
      void editor.ensureSaved().then(() => toast("The agent wrote the frame’s prompt from its beat"));
    }
  }, [framePromptRuns, boards.frames, setFrame, editor, toast]);
  /* A finished sketch reading becomes that frame's reading and prompt. */
  useEffect(() => {
    for (const job of sketchRuns) {
      const read = job.result?.sketch;
      if (job.status !== "succeeded" || !read || taking.current.has(job.id)) continue;
      const frame = boards.frames[read.shotId];
      /* Only the newest reading of the drawing the frame still has, and only once. */
      if (!frame || frame.readingJobId === job.id || frame.sketch?.assetId !== job.sketchAssetId || sketchRuns.find((j) => j.shotId === job.shotId) !== job) continue;
      taking.current.add(job.id);
      setFrame(read.shotId, (f) => ({ ...f, reading: read.reading.slice(0, 4000), readingJobId: job.id, prompt: read.prompt.slice(0, FRAME_PROMPT_LIMIT) }));
      void editor.ensureSaved().then(() => toast("The agent read the drawing and wrote the frame’s prompt"));
    }
  }, [sketchRuns, boards.frames, setFrame, editor, toast]);

  /* ── Frames in flight: poll each until it lands, then file it as a Storyboard asset. ── */
  const pendings = Object.entries(boards.frames).flatMap(([shotId, frame]) => (frame.pending ?? []).map((pend) => ({ shotId, shot: shots.find((shot) => shot.id === shotId), pend })));
  const pendingKey = pendings.map((x) => x.pend.jobId).join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let alive = true, reading = false;
    const controller = new AbortController();
    const tick = async () => {
      if (reading) return;
      reading = true;
      for (const { shotId, shot, pend } of pendings) {
        try {
          const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(pend.jobId)}`, { signal: controller.signal, headers: { "X-Workbench-Scope": scope } });
          if (!alive || !DONE.has(generation.status)) continue;
          const ok = generation.status === "succeeded";
          editor.change((old) => {
            const b = old.production?.boards ?? DEFAULT_BOARDS;
            const f = b.frames[shotId];
            if (!f?.pending?.some((job) => job.jobId === pend.jobId)) return old;
            const frame: BoardFrame = { ...f, pending: (f.pending ?? []).filter((x) => x.jobId !== pend.jobId), ...(ok ? { takes: [{ genId: generation.id, style: pend.style, at: new Date().toISOString() }, ...f.takes].slice(0, 20), selected: generation.id } : {}) };
            const asset: Asset = { id: generation.id, generationId: generation.id, kind: "image", category: "Storyboard", name: shot ? `Frame ${shot.number}` : "Storyboard frame", url: `/api/media/${generation.id}`, description: shot?.scene ?? "", prompt: f.prompt, status: "Draft", locked: false, version: f.takes.length + 1, refs: [] };
            const assets = ok && !old.assets.some((a) => a.id === asset.id) && old.assets.length < PROJECT_LIMITS.assets ? [...old.assets, asset] : old.assets;
            return { ...old, assets, production: { ...old.production, boards: { ...b, frames: { ...b.frames, [shotId]: frame } } } };
          });
          if (!ok) setErrors((e) => ({ ...e, [shotId]: generation.failure ? failureLine(generation.failure).text : generation.error || "This frame did not render." }));
          void editor.ensureSaved().then(() => { if (ok) void refreshProjectLibrary(scope, latest.current.id); });
        } catch { /* the next tick reads it again */ }
        if (!alive) break;
      }
      reading = false;
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, scope]);

  /* ── Pricing and rendering one frame through the quoted /api/generate path. ── */
  const pickedShots = shots.filter((s) => picked.includes(s.id));
  const missing = shots.filter((s) => frameOf(s.id).prompt.trim() && !frameOf(s.id).takes.length && !(frameOf(s.id).pending ?? []).length);
  const candidate = (shot: NumberedShot) => {
    const frame = frameOf(shot.id);
    return !frame.prompt.trim() && picked.includes(shot.id) ? { ...frame, prompt: shotPrompt(shot) } : frame;
  };
  const quoteInputs = Object.fromEntries(shots.flatMap((shot) => {
    const input = frameRequest(p, boards, candidate(shot));
    const revision = (revising[shot.id] ?? "").trim();
    const revised = revision ? frameRequest(p, boards, { ...frameOf(shot.id), prompt: revision }) : null;
    return [...(input ? [[shot.id, { body: generationRequestBody(input) }]] : []), ...(revised ? [[`revision-${shot.id}`, { body: generationRequestBody(revised) }]] : [])];
  }));
  const pricing = useStageQuotes(scope, quoteInputs);
  const sending = useRef(new Set<string>());
  const batchSending = useRef(false);
  const batchPrice = (list: NumberedShot[]) => list.length && list.every((shot) => pricing.quotes[shot.id]?.credits != null)
    ? list.reduce((sum, shot) => sum + pricing.quotes[shot.id]!.credits!, 0) : null;
  const missingPrice = batchPrice(missing);
  const pickedPrice = batchPrice(pickedShots);
  /* A batch whose frame's price could not be read says so and reads just those frames again. */
  const unpriced = (list: NumberedShot[]) => list.filter((shot) => pricing.quotes[shot.id]?.error);
  const missingUnpriced = unpriced(missing);
  const pickedUnpriced = unpriced(pickedShots);
  const tryAgainAll = (list: NumberedShot[]) => { for (const shot of list) pricing.tryAgain(shot.id); };
  const togglePick = (id: string) => setPicked((all) => all.includes(id) ? all.filter((x) => x !== id) : [...all, id]);

  const render = async (shot: NumberedShot, shown: number, frame = frameOf(shot.id), quoteId = shot.id) => {
    const input = frameRequest(p, boards, frame);
    if (!input || sending.current.has(shot.id)) return false;
    const previousPrompt = frameOf(shot.id).prompt;
    sending.current.add(shot.id);
    /* A new send replaces what the last attempt said. */
    setWorking((w) => ({ ...w, [shot.id]: "Sending…" })); setErrors((e) => ({ ...e, [shot.id]: "" }));
    try {
      if (!(await editor.ensureSaved())) throw new Error("Save the project before rendering a frame.");
      const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, p.id, `board-${shot.id}`), shown, request: { endpoint: "/api/generate", input } });
      if (outcome.state === "repriced") { pricing.reprice(quoteId, outcome.credits); setErrors((e) => ({ ...e, [shot.id]: outcome.reason })); return false; }
      if (outcome.state === "refused") { setErrors((e) => ({ ...e, [shot.id]: outcome.reason })); return false; }
      setFrame(shot.id, (f) => ({ ...f, ...(f.prompt === previousPrompt ? { prompt: frame.prompt } : {}), pending: f.pending?.some((job) => job.jobId === outcome.jobId) ? f.pending : [...(f.pending ?? []), { jobId: outcome.jobId, style: frame.style ?? boards.style, at: new Date().toISOString() }] }));
      void editor.ensureSaved();
      return true;
    } catch (error) { setErrors((e) => ({ ...e, [shot.id]: error instanceof Error ? error.message : "The frame could not be sent." })); return false; }
    finally { sending.current.delete(shot.id); setWorking((w) => ({ ...w, [shot.id]: "" })); }
  };
  const revise = async (shot: NumberedShot, credits: number) => {
    const fresh = (revising[shot.id] ?? "").trim().slice(0, FRAME_PROMPT_LIMIT);
    if (!fresh) return;
    if (await render(shot, credits, { ...frameOf(shot.id), prompt: fresh }, `revision-${shot.id}`)) {
      setRevising((r) => { const next = { ...r }; delete next[shot.id]; return next; });
    }
  };
  const reviseAll = (list: NumberedShot[]) => setRevising((r) => ({ ...Object.fromEntries(list.filter((s) => frameOf(s.id).takes.length).map((s) => [s.id, r[s.id] ?? ""])), ...r }));
  /* Deleting a line drawing takes it out of the project and off its beat; the Rig's inputs are protected. */
  const removeDrawing = async (drawing: Asset) => {
    try { deleteDrawing(latest.current, drawing.id); editor.change((old) => deleteDrawing(old, drawing.id)); setDropping(null); if (await editor.ensureSaved()) toast(`${drawing.name} deleted`); }
    catch (error) { setDropping(null); runs.setError(error instanceof Error ? error.message : "The drawing could not be deleted."); }
  };
  /* Sent one by one at the prices shown, stopping at the first refusal or changed price; answers the frames sent. */
  const renderAll = async (list: NumberedShot[]) => {
    const sent: string[] = [];
    if (batchSending.current || batchPrice(list) == null) return sent;
    const todo = list.map((shot) => ({ shot, frame: candidate(shot), credits: pricing.quotes[shot.id]!.credits! }));
    batchSending.current = true; setBatchWorking(true);
    try { for (const { shot, frame, credits } of todo) { if (!(await render(shot, credits, frame))) break; sent.push(shot.id); } }
    finally { batchSending.current = false; setBatchWorking(false); }
    return sent;
  };

  /* Line drawings: uploaded together, each put on its beat (the frame's drawing), read by the agent, converted in its look. */
  const drawings = p.assets.filter((a) => a.kind === "image" && (a.category === "Line drawing" || a.category === "Sketch"));
  const drawingShot = (assetId: string) => shots.find((s2) => boards.frames[s2.id]?.sketch?.assetId === assetId) ?? null;
  const uploadDrawings = async (files: File[]) => {
    setWorking((w) => ({ ...w, drawings: `Uploading ${files.length}…` }));
    try {
      const made: Asset[] = [];
      for (const file of files) {
        if (!/^image\//.test(file.type)) throw new Error(`${file.name} is not an image.`);
        const uploaded = await uploadWorkbench(file, undefined, scope);
        made.push({ id: uploaded.id, uploadId: uploaded.id, kind: "image", category: "Line drawing", name: file.name.slice(0, 200), url: uploaded.url, mime: uploaded.mime || file.type, description: "A line drawing of a beat", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
      }
      editor.change((old) => ({ ...old, assets: [...old.assets, ...made.filter((a) => !old.assets.some((x) => x.id === a.id))].slice(0, PROJECT_LIMITS.assets) }));
      if (!(await editor.ensureSaved())) throw new Error("The drawings uploaded, but the project is not saved yet.");
      toast(`${made.length} line ${made.length === 1 ? "drawing" : "drawings"} uploaded — put each on its beat`);
    } catch (error) { runs.setError(error instanceof Error ? error.message : "The drawings could not be uploaded."); }
    finally { setWorking((w) => ({ ...w, drawings: "" })); }
  };
  const assignDrawing = (drawing: Asset, shotId: string) => {
    setBoards((b) => {
      const frames = { ...b.frames };
      for (const [id, f] of Object.entries(frames)) if (f.sketch?.assetId === drawing.id) frames[id] = { ...f, sketch: undefined, reading: undefined, readingJobId: undefined };
      if (shotId) { const f = frames[shotId] ?? emptyFrame(); frames[shotId] = { ...f, sketch: { assetId: drawing.id, name: drawing.name }, reading: undefined, readingJobId: undefined }; }
      return { ...b, frames };
    });
    void editor.ensureSaved();
  };
  const uploadSketch = async (shot: NumberedShot, file: File) => {
    setWorking((w) => ({ ...w, [shot.id]: "Uploading the drawing…" }));
    try {
      if (!/^image\//.test(file.type)) throw new Error("Upload the drawing as an image (PNG or JPEG).");
      const uploaded = await uploadWorkbench(file, undefined, scope);
      const asset: Asset = { id: uploaded.id, uploadId: uploaded.id, kind: "image", category: "Sketch", name: file.name.slice(0, 200), url: uploaded.url, mime: uploaded.mime || file.type, description: `Rough drawing for shot ${shot.number}`, prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
      editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
      setFrame(shot.id, (f) => ({ ...f, sketch: { assetId: asset.id, name: asset.name }, reading: undefined, readingJobId: undefined }));
      if (!(await editor.ensureSaved())) throw new Error("The drawing uploaded, but the project is not saved yet.");
    } catch (error) { setErrors((e) => ({ ...e, [shot.id]: error instanceof Error ? error.message : "The drawing could not be uploaded." })); }
    finally { setWorking((w) => ({ ...w, [shot.id]: "" })); }
  };

  /* A picture dropped on a frame — a tile from anywhere, or a file from the device — becomes the shot's rough drawing, read and converted like an upload. */
  const [dropOver, setDropOver] = useState<string | null>(null);
  const dropOnFrame = (shot: NumberedShot, e: React.DragEvent) => {
    e.preventDefault(); setDropOver(null);
    const { ids, files } = readDrop(e.dataTransfer, p.assets);
    const file = files.find((f) => f.type.startsWith("image/"));
    if (file) { void uploadSketch(shot, file); return; }
    if (files.length) { setErrors((x) => ({ ...x, [shot.id]: "A drawing is a picture; the other files are not used here." })); return; }
    if (!ids[0]) return;
    void (async () => {
      setWorking((w) => ({ ...w, [shot.id]: "Placing the drawing…" }));
      try {
        const got = await resolveGenInput(ids[0], scope);
        if (got.kind !== "image") throw new Error("A drawing is a picture.");
        await placeDrawing(shot, got);
      } catch (error) { setErrors((x) => ({ ...x, [shot.id]: error instanceof Error ? error.message : "The drawing could not be placed." })); }
      finally { setWorking((w) => ({ ...w, [shot.id]: "" })); }
    })();
  };
  /* One picture as the shot's rough drawing — from a drop or a prompt box's attachment. */
  const placeDrawing = async (shot: NumberedShot, got: GenInputAsset) => {
    const asset: Asset = { id: got.id, ...(got.origin === "generation" ? { generationId: got.id } : { uploadId: got.id }), kind: "image", category: "Sketch", name: got.name.slice(0, 200), url: got.url, mime: got.mime, description: `Rough drawing for shot ${shot.number}`, prompt: "", status: "Draft", locked: false, version: 1, refs: [] };
    editor.change((old) => ({ ...old, assets: old.assets.some((a) => a.id === asset.id) ? old.assets : [...old.assets, asset] }));
    setFrame(shot.id, (f) => ({ ...f, sketch: { assetId: asset.id, name: asset.name }, reading: undefined, readingJobId: undefined }));
    await editor.ensureSaved();
  };
  const attachToFrame = (shot: NumberedShot) => async (attached: Attached) => {
    const { media, unreadable } = await resolveAttached(scope, attached);
    const picture = media.find((m) => m.kind === "image");
    if (picture) await placeDrawing(shot, picture);
    const kept = [...unreadable, ...media.filter((m) => m !== picture).map((m) => m.name)];
    return [picture ? `${picture.name} is the rough drawing for shot ${shot.number}; the agent reads it and the frame keeps its blocking.` : "", keptNote(kept, "a frame takes one picture as its drawing.") ?? ""].filter(Boolean).join(" ") || null;
  };

  const model = agent.model;
  const q = runs.quote && runs.quote.input.model === model?.id && runs.quote.input.effort === agent.effort ? runs.quote : null;
  const promptsQuote = q && q.input.kind === "frames" && !q.input.shotId ? q : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : activePrompts || activeSketch ? "The agent is working." : !model ? "Choose an agent above." : null;

  if (!shots.length) {
    return (
      <div className="pd-stage gx-enter" data-testid="boards-stage">
        <section className="gx-gen-card pd-gate" data-testid="boards-no-shots">
          <span className="gx-eyebrow" data-functional-label="">Storyboards</span>
          <p className="gx-hint">Storyboards are drawn from the beat sheet’s shots. Break the script into beats and shots first.</p>
          <button type="button" className="gx-primary" onClick={onBeats}>Open Beats</button>
        </section>
      </div>
    );
  }

  const rendered = shots.filter((s) => frameOf(s.id).takes.length).length;
  return (
    <div className="pd-stage gx-enter" data-testid="boards-stage">
      <AgentBar models={runs.models} agent={agent} loaded={runs.loaded} disabled={Boolean(activePrompts || activeSketch) || Boolean(runs.busy)} />
      {runs.pending ? (
        <div className="gx-gen-card pd-recover" role="alert">
          <p className="gx-hint">An earlier agent request was sent but not confirmed. Recovering it re-reads that exact request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={Boolean(runs.busy)} onClick={() => void runs.start()}>{runs.busy || "Recover the request"}</button>
        </div>
      ) : null}
      {runs.error ? <p className="gx-gen-error" role="alert" data-testid="agent-error">{runs.error}</p> : null}

      <section className="gx-gen-card" aria-label="Look" data-testid="boards-look" data-section="look">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Look</span>
          <span className="gx-spacer" />
          <span className="gx-hint" data-testid="boards-counts">{shots.length} shots · {rendered} framed</span>
        </div>
        <div className="pd-styles" role="radiogroup" aria-label="Storyboard look">
          {BOARD_STYLES.map((style) => (
            <button key={style.id} type="button" role="radio" aria-checked={boards.style === style.id} className="pd-style" onClick={() => setBoards((b) => ({ ...b, style: style.id }))} data-testid={`boards-style-${style.id}`}>
              <span className="pd-style-name">{style.label}</span><span className="gx-hint">{style.line}</span>
            </button>
          ))}
        </div>
        <div className="pd-row-head">
          <span className="gx-hint">Engine</span>
          <div className="gx-seg gx-seg--sm pd-engines" role="radiogroup" aria-label="Frame engine">
            {BOARD_MODELS.map((m) => <button key={m.id} type="button" role="radio" className="gx-seg-btn" aria-checked={boards.model === m.id} onClick={() => setBoards((b) => ({ ...b, model: m.id }))}><span>{m.label}</span></button>)}
          </div>
          <span className="gx-hint">{p.aspect} · each frame priced before it renders</span>
        </div>
      </section>

      <section className="gx-gen-card" aria-label="Frame prompts" data-testid="boards-prompts" data-section="prompts">
        <span className="gx-eyebrow" data-functional-label="">Frame prompts</span>
        <p className="gx-hint">The agent writes a prompt for every shot from the beat sheet, the direction and the cast. Prompts you have written yourself are kept.</p>
        {activePrompts ? <p className="gx-hint" role="status" data-testid="boards-prompts-progress">{agentLabel(agentFamilyOf(activePrompts.model) ?? "claude")} is writing the prompts · step {Math.min(activePrompts.completedSteps + 1, activePrompts.totalSteps)} of {activePrompts.totalSteps}</p> : null}
        <AgentAction id="boards-prompts" estimateLabel="Estimate the frame prompts" startLabel={(price) => `Write every prompt · up to ${price}`} quote={promptsQuote} busy={runs.busy} blocked={blocked}
          describe={(qq, price) => `${shots.length} shots · ${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${price}`}
          onEstimate={() => void runs.estimate({ kind: "frames", model: model!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={!missing.length || batchWorking || missingPrice == null} onClick={() => void renderAll(missing)} data-testid="boards-render-all">
            {batchWorking ? "Sending frames…" : missingPrice != null ? `Render ${missing.length} frames · ${missingPrice.toLocaleString()} credits` : missingUnpriced.length ? "Price unavailable" : missing.length ? "Pricing frames…" : "No missing frames"}
          </button>
          {missingUnpriced.length && !batchWorking ? <button type="button" className="gx-hbtn" onClick={() => tryAgainAll(missingUnpriced)} data-testid="boards-render-all-retry">Try again</button> : null}
        </div>
      </section>

      <section className="gx-gen-card" aria-label="Line drawings" data-testid="line-drawings" data-section="drawings">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Line drawings</span>
          <span className="gx-spacer" />
          <span className="gx-hint">{drawings.length} uploaded · {drawings.filter((d) => drawingShot(d.id)).length} on a beat</span>
        </div>
        <p className="gx-hint">Upload your own line drawings of the beats. Put each on its beat, choose how it should come out — live action, a coloured sketch or black and white — and the agent reads your blocking and turns it into a proper storyboard frame.</p>
        <label className="gx-hbtn pd-upload">
          {working.drawings || "Upload line drawings"}
          <input type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Upload line drawings" onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void uploadDrawings(files); }} data-testid="drawings-upload" />
        </label>
        {drawings.length ? (
          <div className="pd-drawings">
            {drawings.map((drawing) => {
              const shot = drawingShot(drawing.id);
              const frame = shot ? frameOf(shot.id) : null;
              const look = frame?.style ?? boards.style;
              const readQuote = shot && q && q.input.kind === "sketch" && q.input.shotId === shot.id && q.input.sketchAssetId === drawing.id ? q : null;
              const quote = shot ? pricing.quotes[shot.id] : undefined;
              /* The drawing's frame is rendering: Convert stays closed until that job lands or fails, as the frame's own action does. */
              const converting = Boolean(frame?.pending?.length);
              const done = shot && frame?.takes.length ? frame.selected ?? frame.takes[0].genId : null;
              return (
                <article key={drawing.id} className="pd-drawing" data-testid="line-drawing" aria-label={drawing.name}>
                  <div className="pd-drawing-pair">
                    <LazyMedia url={drawing.url} kind="image" alt={`Line drawing ${drawing.name}`} className="gx-lazy" />
                    <span className="pd-drawing-out">{done ? <LazyMedia url={`/api/media/${done}`} kind="image" alt="The frame" className="gx-lazy" /> : <span className="gx-hint">{frame?.pending?.length ? "Converting…" : "Frame appears here"}</span>}</span>
                  </div>
                  <div className="pd-drawing-delete">
                    {dropping === drawing.id ? (
                      <>
                        <button type="button" className="gx-hbtn gx-hbtn--danger" onClick={() => void removeDrawing(drawing)} data-testid="drawing-delete-confirm">Delete this drawing{shot ? ` and take it off beat ${shot.number}` : ""}</button>
                        <button type="button" className="gx-hbtn" onClick={() => setDropping(null)}>Keep it</button>
                      </>
                    ) : <button type="button" className="gx-hbtn gx-hbtn--danger" aria-label={`Delete ${drawing.name}`} onClick={() => setDropping(drawing.id)} data-testid="drawing-delete">Delete</button>}
                  </div>
                  <select aria-label={`Beat for ${drawing.name}`} value={shot?.id ?? ""} onChange={(e) => assignDrawing(drawing, e.target.value)} data-testid="drawing-shot">
                    <option value="">Put it on a beat…</option>
                    {shots.map((s2) => <option key={s2.id} value={s2.id}>{s2.number} — {(s2.shot.description || s2.scene).slice(0, 60)}</option>)}
                  </select>
                  {shot && frame ? (
                    <>
                      <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label={`Look for ${drawing.name}`}>
                        {BOARD_STYLES.map((st) => <button key={st.id} type="button" role="radio" className="gx-seg-btn" aria-checked={look === st.id} onClick={() => setFrame(shot.id, (f) => ({ ...f, style: st.id }))} data-testid={`drawing-look-${st.id}`}><span>{st.label}</span></button>)}
                      </div>
                      {frame.reading ? <p className="gx-hint pd-reading" data-testid="drawing-reading"><strong>The agent read:</strong> {frame.reading}</p> : null}
                      <AgentAction id={`drawing-read-${drawing.id}`} secondary estimateLabel={frame.reading ? "Read it again" : "1 · The agent reads the drawing"} startLabel={(price) => `Read it · up to ${price}`}
                        quote={readQuote} busy={runs.busy} blocked={blocked ?? (!model?.vision ? `${model?.name ?? "This model"} cannot see images. Choose an agent model that can.` : null)}
                        describe={(qq, price) => `${qq.value.calls} agent steps with the drawing · ${thinkingModelName(qq.input.model)} · up to ${price}`}
                        onEstimate={() => void runs.estimate({ kind: "sketch", model: model!.id, effort: agent.effort, shotId: shot.id, sketchAssetId: drawing.id })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
                      <div className="gx-gen-enhance">
                        <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || batchWorking || converting || !frame.reading || quote?.credits == null} title={!frame.reading ? "Have the agent read the drawing first." : undefined} onClick={() => { if (quote?.credits != null && !converting) void render(shot, quote.credits); }} data-testid="drawing-render">
                          {working[shot.id] || (converting ? "Rendering…" : quote?.credits != null ? `2 · Convert · ${quote.credits.toLocaleString()} credits` : quote?.error ? "Price unavailable" : "Pricing conversion…")}
                        </button>
                        {quote?.error ? <button type="button" className="gx-hbtn" onClick={() => pricing.tryAgain(shot.id)}>Try again</button> : null}
                      </div>
                      {errors[shot.id] || quote?.error ? <p className="gx-gen-error" role="alert">{errors[shot.id] || quote?.error}</p> : null}
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      <div className="gx-gen-card pd-select-bar" role="region" aria-label="Selected frames" data-testid="boards-selection">
        <span className="gx-eyebrow" data-functional-label="">{picked.length ? `${picked.length} selected` : "Select frames to storyboard together"}</span>
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" onClick={() => setPicked(picked.length === shots.length ? [] : shots.map((s) => s.id))} data-testid="boards-select-all">{picked.length === shots.length ? "Clear" : "Select all"}</button>
        {/* What was sent leaves the selection, so the same priced batch is not offered a second time. */}
        <button type="button" className="gx-primary" disabled={!picked.length || batchWorking || pickedPrice == null} onClick={() => void renderAll(pickedShots).then((sent) => setPicked((all) => all.filter((id) => !sent.includes(id))))} data-testid="boards-render-selected">
          {batchWorking ? "Sending frames…" : pickedPrice != null ? `Storyboard ${picked.length} frames · ${pickedPrice.toLocaleString()} credits` : pickedUnpriced.length ? "Price unavailable" : picked.length ? "Pricing selected frames…" : "Storyboard selected (0)"}
        </button>
        {pickedUnpriced.length && !batchWorking ? <button type="button" className="gx-hbtn" onClick={() => tryAgainAll(pickedUnpriced)} data-testid="boards-render-selected-retry">Try again</button> : null}
        <button type="button" className="gx-hbtn" disabled={!pickedShots.some((s) => frameOf(s.id).takes.length)} title="Write a fresh prompt for each selected frame that has a picture." onClick={() => reviseAll(pickedShots)} data-testid="boards-revise-selected">Revise selected</button>
      </div>

      <section className="pd-frames" aria-label="Frames" data-testid="boards-frames" data-section="frames">
        {shots.map((shot) => {
          const frame = frameOf(shot.id);
          const shown = frame.selected ?? frame.takes[0]?.genId;
          const inFlight = (frame.pending ?? []).length > 0;
          const quote = pricing.quotes[shot.id];
          const revisionQuote = pricing.quotes[`revision-${shot.id}`];
          const sketchAsset = frame.sketch ? p.assets.find((a) => a.id === frame.sketch!.assetId) : undefined;
          const sketchQuote = q && q.input.kind === "sketch" && q.input.shotId === shot.id && q.input.sketchAssetId === frame.sketch?.assetId ? q : null;
          const canSee = Boolean(model?.vision);
          return (
            <article key={shot.id} className="gx-gen-card pd-frame" data-testid="board-frame" data-picked={picked.includes(shot.id) || undefined} aria-label={`Shot ${shot.number}`} data-drop={dropOver === shot.id || undefined}
              onDragOver={(e) => { if (isDroppable(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropOver(shot.id); } }}
              onDragLeave={() => setDropOver((v) => (v === shot.id ? null : v))} onDrop={(e) => dropOnFrame(shot, e)}>
              <label className="pd-frame-pick">
                <input type="checkbox" checked={picked.includes(shot.id)} onChange={() => togglePick(shot.id)} aria-label={`Select shot ${shot.number}`} data-testid="frame-select" />
                <span>Select</span>
              </label>
              <div className="pd-frame-image" data-ratio={p.aspect}>
                {shown ? <LazyMedia url={`/api/media/${shown}`} kind="image" alt={`Frame ${shot.number}`} className="gx-lazy" /> : <span className="gx-hint">{inFlight ? "Rendering…" : "No frame yet"}</span>}
                {inFlight && shown ? <span className="gx-badge gx-badge--new">Rendering</span> : null}
              </div>
              <div className="pd-row-head">
                <span className="pd-shot-n">{shot.number}</span>
                <span className="gx-hint pd-frame-scene" title={shot.scene}>{shot.scene}</span>
              </div>
              <p className="gx-hint pd-frame-desc">{shot.shot.description || "No description in the beat sheet."}</p>
              {frame.takes.length > 1 ? (
                <div className="pd-takes" role="radiogroup" aria-label={`Shot ${shot.number} frames`}>
                  {frame.takes.map((take, i) => <button key={take.genId} type="button" role="radio" aria-checked={take.genId === shown} aria-label={`Frame ${frame.takes.length - i}`} onClick={() => setFrame(shot.id, (f) => ({ ...f, selected: take.genId }))}><LazyMedia url={`/api/media/${take.genId}`} kind="image" alt="" className="gx-lazy" /></button>)}
                </div>
              ) : null}
              <div className="gx-gen-enhance">
                {/* An empty prompt starts from its beat — decided on the frame as it is when this lands, not as this render saw it: the agent's prompts may have landed in between, and are never written over. */}
                <button type="button" className="gx-hbtn" aria-expanded={open === shot.id} onClick={() => { setOpen(open === shot.id ? null : shot.id); setFrame(shot.id, (f) => (f.prompt.trim() ? f : { ...f, prompt: shotPrompt(shot) })); }} data-testid="frame-prompt-toggle">Prompt</button>
                {frame.takes.length ? <button type="button" className="gx-hbtn" aria-expanded={shot.id in revising} onClick={() => setRevising((r) => { const next = { ...r }; if (shot.id in next) delete next[shot.id]; else next[shot.id] = ""; return next; })} data-testid="frame-revise">Revise</button> : null}
                {/* Closed while this frame renders, until its job lands or fails: one more tap never buys a second take. */}
                <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || batchWorking || inFlight || quote?.credits == null} onClick={() => { if (quote?.credits != null && !inFlight) void render(shot, quote.credits, candidate(shot)); }} data-testid="frame-render">
                  {working[shot.id] || (inFlight ? "Rendering…" : quote?.credits != null ? `Render frame · ${quote.credits.toLocaleString()} credits` : quote?.error ? "Price unavailable" : frame.prompt.trim() ? "Pricing…" : "Render frame")}
                </button>
                {quote?.error ? <button type="button" className="gx-hbtn" onClick={() => pricing.tryAgain(shot.id)}>Try again</button> : null}
              </div>
              <AgentAction id={`frame-agent-${shot.id}`} secondary estimateLabel="Prompt with the agent" startLabel={(price) => `Write it · up to ${price}`}
                quote={q && q.input.kind === "frames" && q.input.shotId === shot.id ? q : null} busy={runs.busy} blocked={blocked}
                describe={(qq, price) => `The agent reads beat ${shot.number} · ${qq.value.calls} steps · ${thinkingModelName(qq.input.model)} · up to ${price}`}
                onEstimate={() => void runs.estimate({ kind: "frames", model: model!.id, effort: agent.effort, shotId: shot.id })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
              {!frame.prompt.trim() && open !== shot.id ? <span className="gx-reason">Write this frame’s prompt first.</span> : null}
              {shot.id in revising ? (
                <div className="pd-frame-edit" data-testid="frame-reviser">
                  <label className="gx-gen-row">
                    <span className="gx-eyebrow" data-functional-label="">Revise · a fresh prompt for shot {shot.number}</span>
                    <PromptAttach scope={scope} projectId={p.id} onAttach={attachToFrame(shot)} testId="frame-revise-attach"><textarea className="gx-textarea pd-small" aria-label={`Fresh prompt for shot ${shot.number}`} maxLength={FRAME_PROMPT_LIMIT} value={revising[shot.id]} placeholder="Describe this frame afresh — what you want to see instead."
                      onChange={(e) => { const v = e.target.value; setRevising((r) => ({ ...r, [shot.id]: v })); }} data-testid="frame-revise-prompt" /></PromptAttach>
                  </label>
                  <div className="gx-gen-enhance">
                    <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || batchWorking || revisionQuote?.credits == null} onClick={() => { if (revisionQuote?.credits != null) void revise(shot, revisionQuote.credits); }} data-testid="frame-revise-render">{working[shot.id] || (revisionQuote?.credits != null ? `Render revision · ${revisionQuote.credits.toLocaleString()} credits` : revisionQuote?.error ? "Price unavailable" : "Pricing revision…")}</button>
                    {revisionQuote?.error ? <button type="button" className="gx-hbtn" onClick={() => pricing.tryAgain(`revision-${shot.id}`)}>Try again</button> : null}
                    <button type="button" className="gx-hbtn" onClick={() => setRevising((r) => ({ ...r, [shot.id]: frame.prompt }))}>Start from the current prompt</button>
                    <button type="button" className="gx-hbtn" onClick={() => setRevising((r) => { const next = { ...r }; delete next[shot.id]; return next; })}>Cancel</button>
                  </div>
                  {revisionQuote?.error ? <p className="gx-gen-error" role="alert">{revisionQuote.error}</p> : null}
                  <span className="gx-hint">The revision is a new frame; the ones you have stay under the picture.</span>
                </div>
              ) : null}
              {open === shot.id ? (
                <div className="pd-frame-edit" data-testid="frame-editor">
                  <label className="gx-gen-row">
                    <span className="gx-eyebrow" data-functional-label="">Prompt · shot {shot.number}</span>
                    <PromptAttach scope={scope} projectId={p.id} onAttach={attachToFrame(shot)} testId="frame-prompt-attach"><textarea className="gx-textarea pd-small" aria-label={`Shot ${shot.number} prompt`} maxLength={FRAME_PROMPT_LIMIT} value={frame.prompt} onChange={(e) => { const v = e.target.value; setFrame(shot.id, (f) => ({ ...f, prompt: v })); }} data-testid="frame-prompt" /></PromptAttach>
                  </label>
                  <div className="gx-gen-row">
                    <span className="gx-eyebrow" data-functional-label="">Rough drawing</span>
                    {sketchAsset ? (
                      <div className="pd-sketch">
                        <LazyMedia url={sketchAsset.url} kind="image" alt={`Drawing for shot ${shot.number}`} className="gx-lazy" />
                        <span className="gx-hint">{frame.sketch!.name} · the frame keeps its blocking</span>
                        <button type="button" className="gx-hbtn" onClick={() => setFrame(shot.id, (f) => ({ ...f, sketch: undefined, reading: undefined, readingJobId: undefined }))}>Remove</button>
                      </div>
                    ) : null}
                    <label className="gx-hbtn pd-upload">
                      {sketchAsset ? "Replace the drawing" : "Upload a rough drawing"}
                      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Upload a rough drawing for shot ${shot.number}`} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadSketch(shot, file); }} data-testid="frame-sketch-upload" />
                    </label>
                    {sketchAsset ? (
                      <>
                        {frame.reading ? <p className="gx-hint pd-reading" data-testid="frame-reading"><strong>The agent read:</strong> {frame.reading}</p> : null}
                        <AgentAction id={`frame-read-${shot.id}`} secondary estimateLabel={frame.reading ? "Read the drawing again" : "Have the agent read the drawing"} startLabel={(price) => `Read it · up to ${price}`}
                          quote={sketchQuote} busy={runs.busy} blocked={blocked ?? (!canSee ? `${model?.name ?? "This model"} cannot see images. Choose an agent model that can.` : null)}
                          describe={(qq, price) => `${qq.value.calls} agent steps with the drawing · ${thinkingModelName(qq.input.model)} · up to ${price}`}
                          onEstimate={() => void runs.estimate({ kind: "sketch", model: model!.id, effort: agent.effort, shotId: shot.id, sketchAssetId: frame.sketch!.assetId })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
                        {activeSketch ? <p className="gx-hint" role="status">{agentLabel(agentFamilyOf(activeSketch.model) ?? "claude")} is reading the drawing…</p> : null}
                      </>
                    ) : <p className="gx-hint">Upload your own line drawing and the agent reads its blocking; the rendered frame keeps your composition and choreography.</p>}
                  </div>
                </div>
              ) : null}
              {errors[shot.id] || quote?.error ? <p className="gx-gen-error" role="alert" data-testid="frame-error">{errors[shot.id] || quote?.error}</p> : null}
            </article>
          );
        })}
      </section>
      {onRig ? <div className="pd-next"><button type="button" className="gx-primary" disabled={!rendered} onClick={onRig} data-testid="boards-to-rig">Take the frames to Rig ›</button></div> : null}
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}{editor.notice ? ` · ${editor.notice}` : ""}</p>
    </div>
  );
}
