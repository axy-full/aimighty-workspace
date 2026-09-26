"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { PromptAttach, keptNote, resolveAttached, type Attached } from "@/components/PromptAttach";
import { isDroppable, readDrop } from "@/lib/drop";
import { resolveGenInput, type GenInputAsset } from "@/lib/genAssetInput";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { BOARD_MODELS, BOARD_STYLES, deleteDrawing, stillShape, DEFAULT_BOARDS, FRAME_PROMPT_LIMIT, boardShots, emptyFrame, renderPrompt, shotPrompt, type BoardFrame, type Boards, type NumberedShot } from "@/lib/production/boards";
import { getModel } from "@/lib/models";
import { generationRequestBody, type GenerationBodyInput } from "@/lib/workbench/generation-request";
import { pendingGenerationKey } from "@/lib/workbench/pending-generation";
import type { Asset, Project } from "@/lib/workbench/studio";
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

type Quote = { key: string; credits: number };
type Generation = { id: string; status: string; error?: string | null };
const DONE = new Set(["succeeded", "failed", "cancelled"]);

/** The request one frame sends: its prompt in the chosen look, the project's ratio, and its drawing as the reference. */
export function frameRequest(project: Project, boards: Boards, frame: BoardFrame): GenerationBodyInput | null {
  if (!project.productionProjectId || !frame.prompt.trim()) return null;
  const sketch = frame.sketch ? project.assets.find((a) => a.id === frame.sketch!.assetId) : undefined;
  return {
    prompt: renderPrompt(frame.prompt, frame.style ?? boards.style, Boolean(sketch)), kind: "image", model: { id: boards.model },
    mapping: { shotId: "", productionProjectId: project.productionProjectId }, ...stillShape(getModel(boards.model), project.aspect), duration: 5,
    references: sketch?.uploadId ? [{ uploadId: sketch.uploadId, role: "reference_image" }] : [], firstFrameAssetId: "",
  };
}

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
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [working, setWorking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<{ ids: string[]; credits: number; keys: Record<string, Quote>; from: "missing" | "picked" } | null>(null);
  /* Frames picked to storyboard together; fresh prompts being written to revise a frame; a drawing about to be deleted. */
  const [picked, setPicked] = useState<string[]>([]);
  const [revising, setRevising] = useState<Record<string, string>>({});
  const [dropping, setDropping] = useState<string | null>(null);
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  const setBoards = useCallback((fn: (b: Boards) => Boards) => editor.change((old) => ({ ...old, production: { ...old.production, boards: fn(old.production?.boards ?? DEFAULT_BOARDS) } })), [editor]);
  const setFrame = useCallback((id: string, fn: (f: BoardFrame) => BoardFrame) => setBoards((b) => ({ ...b, frames: { ...b.frames, [id]: fn(b.frames[id] ?? emptyFrame()) } })), [setBoards]);

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
  const pendings = shots.flatMap((s) => (boards.frames[s.id]?.pending ?? []).map((pend) => ({ shot: s, pend })));
  const pendingKey = pendings.map((x) => x.pend.jobId).join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let alive = true;
    const tick = async () => {
      for (const { shot, pend } of pendings) {
        try {
          const { generation } = await studioRequest<{ generation: Generation }>(`/api/jobs/${encodeURIComponent(pend.jobId)}`, { headers: { "X-Workbench-Scope": scope } });
          if (!alive || !DONE.has(generation.status)) continue;
          const ok = generation.status === "succeeded";
          editor.change((old) => {
            const b = old.production?.boards ?? DEFAULT_BOARDS;
            const f = b.frames[shot.id] ?? emptyFrame();
            const frame: BoardFrame = { ...f, pending: (f.pending ?? []).filter((x) => x.jobId !== pend.jobId), ...(ok ? { takes: [{ genId: generation.id, style: pend.style, at: new Date().toISOString() }, ...f.takes].slice(0, 20), selected: generation.id } : {}) };
            const asset: Asset = { id: generation.id, generationId: generation.id, kind: "image", category: "Storyboard", name: `Frame ${shot.number}`, url: `/api/media/${generation.id}`, description: shot.scene, prompt: f.prompt, status: "Draft", locked: false, version: f.takes.length + 1, refs: [] };
            const assets = ok && !old.assets.some((a) => a.id === asset.id) && old.assets.length < PROJECT_LIMITS.assets ? [...old.assets, asset] : old.assets;
            return { ...old, assets, production: { ...old.production, boards: { ...b, frames: { ...b.frames, [shot.id]: frame } } } };
          });
          if (!ok) setErrors((e) => ({ ...e, [shot.id]: generation.error || "This frame did not render. Nothing was billed for a failed render." }));
          void editor.ensureSaved().then(() => { if (ok) void refreshProjectLibrary(scope, latest.current.id); });
        } catch { /* the next tick reads it again */ }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, scope]);

  /* ── Pricing and rendering one frame through the quoted /api/generate path. ── */
  const quoteKey = (frame: BoardFrame) => JSON.stringify([frame.prompt, frame.style ?? boards.style, boards.model, frame.sketch?.assetId ?? "", p.aspect]);
  const price = async (shot: NumberedShot, frame: BoardFrame = frameOf(shot.id)): Promise<Quote> => {
    if (!(await editor.ensureSaved())) throw new Error("Save the project before pricing a frame.");
    const input = frameRequest(latest.current, boards, frame);
    if (!input) throw new Error(frame.prompt.trim() ? "Save the project to link its production first." : "Write this frame’s prompt first.");
    const fresh = await studioRequest<{ estimatedCredits: number }>("/api/generate/quote", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify(generationRequestBody(input)) });
    return { key: quoteKey(frame), credits: fresh.estimatedCredits };
  };
  const quoteFrame = async (shot: NumberedShot) => {
    setWorking((w) => ({ ...w, [shot.id]: "Pricing…" })); setErrors((e) => ({ ...e, [shot.id]: "" }));
    try { const q = await price(shot); setQuotes((all) => ({ ...all, [shot.id]: q })); }
    catch (error) { setErrors((e) => ({ ...e, [shot.id]: error instanceof Error ? error.message : "This frame could not be priced." })); }
    finally { setWorking((w) => ({ ...w, [shot.id]: "" })); }
  };
  const render = async (shot: NumberedShot, shown: number) => {
    const frame = frameOf(shot.id);
    const input = frameRequest(latest.current, boards, frame);
    if (!input) return;
    setWorking((w) => ({ ...w, [shot.id]: "Sending…" }));
    try {
      const outcome = await dispatchGeneration({ scope, storageId: pendingGenerationKey(scope, p.id, `board-${shot.id}`), shown, request: { endpoint: "/api/generate", input } });
      if (outcome.state === "repriced") { setQuotes((all) => ({ ...all, [shot.id]: { key: quoteKey(frame), credits: outcome.credits } })); setErrors((e) => ({ ...e, [shot.id]: outcome.reason })); return; }
      if (outcome.state === "refused") { setErrors((e) => ({ ...e, [shot.id]: outcome.reason })); return; }
      setQuotes((all) => { const next = { ...all }; delete next[shot.id]; return next; });
      setFrame(shot.id, (f) => ({ ...f, pending: [...(f.pending ?? []), { jobId: outcome.jobId, style: boards.style, at: new Date().toISOString() }].slice(-5) }));
      void editor.ensureSaved();
    } catch (error) { setErrors((e) => ({ ...e, [shot.id]: error instanceof Error ? error.message : "The frame could not be sent." })); }
    finally { setWorking((w) => ({ ...w, [shot.id]: "" })); }
  };

  /* Every frame with a prompt and no picture yet: priced together, sent one by one at the prices shown. */
  const missing = shots.filter((s) => frameOf(s.id).prompt.trim() && !frameOf(s.id).takes.length && !(frameOf(s.id).pending ?? []).length);
  /* Several frames priced together — every frame without a picture, or the ones picked. A picked frame
     with no prompt yet starts from its beat, as its own Prompt button would. */
  const priceMany = async (list: NumberedShot[], from: "missing" | "picked") => {
    setWorking((w) => ({ ...w, [from]: `Pricing ${list.length} frame${list.length === 1 ? "" : "s"}…` }));
    try {
      const keys: Record<string, Quote> = {};
      for (const shot of list) {
        const current = frameOf(shot.id);
        const frame = current.prompt.trim() ? current : { ...current, prompt: shotPrompt(shot) };
        if (frame !== current) setFrame(shot.id, (f) => ({ ...f, prompt: f.prompt.trim() ? f.prompt : frame.prompt }));
        keys[shot.id] = await price(shot, frame);
      }
      setBatch({ ids: list.map((s) => s.id), credits: Object.values(keys).reduce((n, q) => n + q.credits, 0), keys, from });
    } catch (error) { runs.setError(error instanceof Error ? error.message : "The frames could not be priced."); }
    finally { setWorking((w) => ({ ...w, [from]: "" })); }
  };
  const priceAll = () => priceMany(missing, "missing");
  const pickedShots = shots.filter((s) => picked.includes(s.id));
  const togglePick = (id: string) => { setBatch((b) => (b?.from === "picked" ? null : b)); setPicked((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id])); };
  /* Revise: a fresh prompt replaces the frame's, priced first; the new frame joins its takes and the old ones stay. */
  const revise = async (shot: NumberedShot) => {
    const fresh = (revising[shot.id] ?? "").trim().slice(0, FRAME_PROMPT_LIMIT);
    if (!fresh) { setErrors((e) => ({ ...e, [shot.id]: "Write the fresh prompt first." })); return; }
    setWorking((w) => ({ ...w, [shot.id]: "Pricing the revision…" })); setErrors((e) => ({ ...e, [shot.id]: "" }));
    try {
      const frame = { ...frameOf(shot.id), prompt: fresh };
      setFrame(shot.id, (f) => ({ ...f, prompt: fresh }));
      const q2 = await price(shot, frame);
      setQuotes((all) => ({ ...all, [shot.id]: q2 }));
      setRevising((r) => { const next = { ...r }; delete next[shot.id]; return next; });
    } catch (error) { setErrors((e) => ({ ...e, [shot.id]: error instanceof Error ? error.message : "The revision could not be priced." })); }
    finally { setWorking((w) => ({ ...w, [shot.id]: "" })); }
  };
  const reviseAll = (list: NumberedShot[]) => setRevising((r) => ({ ...Object.fromEntries(list.filter((s) => frameOf(s.id).takes.length).map((s) => [s.id, r[s.id] ?? ""])), ...r }));
  /* Deleting a line drawing takes it out of the project and off its beat; the Rig's inputs are protected. */
  const removeDrawing = async (drawing: Asset) => {
    try { deleteDrawing(latest.current, drawing.id); editor.change((old) => deleteDrawing(old, drawing.id)); setDropping(null); if (await editor.ensureSaved()) toast(`${drawing.name} deleted`); }
    catch (error) { setDropping(null); runs.setError(error instanceof Error ? error.message : "The drawing could not be deleted."); }
  };
  const renderAll = async () => {
    if (!batch) return;
    const todo = batch; setBatch(null);
    for (const id of todo.ids) { const shot = shots.find((s) => s.id === id); if (shot) await render(shot, todo.keys[id].credits); }
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
        <AgentAction id="boards-prompts" estimateLabel="Estimate the frame prompts" startLabel={(c) => `Write every prompt · up to ${c} credits`} quote={promptsQuote} busy={runs.busy} blocked={blocked}
          describe={(qq) => `${shots.length} shots · ${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
          onEstimate={() => void runs.estimate({ kind: "frames", model: model!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
        <div className="gx-gen-enhance">
          {batch?.from === "missing" ? (
            <>
              <button type="button" className="gx-primary" onClick={() => void renderAll()} data-testid="boards-render-all">Render {batch.ids.length} frames · {batch.credits.toLocaleString()} credits</button>
              <button type="button" className="gx-hbtn" onClick={() => setBatch(null)}>Change</button>
            </>
          ) : (
            <button type="button" className="gx-hbtn" disabled={!missing.length || Boolean(working.missing)} onClick={() => void priceAll()} data-testid="boards-price-all">{working.missing || `Price every frame without a picture (${missing.length})`}</button>
          )}
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
              const quote = shot && frame && quotes[shot.id] && quotes[shot.id].key === quoteKey(frame) ? quotes[shot.id] : null;
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
                      <AgentAction id={`drawing-read-${drawing.id}`} secondary estimateLabel={frame.reading ? "Read it again" : "1 · The agent reads the drawing"} startLabel={(c) => `Read it · up to ${c} credits`}
                        quote={readQuote} busy={runs.busy} blocked={blocked ?? (!model?.vision ? `${model?.name ?? "This model"} cannot see images. Choose an agent model that can.` : null)}
                        describe={(qq) => `${qq.value.calls} agent steps with the drawing · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
                        onEstimate={() => void runs.estimate({ kind: "sketch", model: model!.id, effort: agent.effort, shotId: shot.id, sketchAssetId: drawing.id })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
                      <div className="gx-gen-enhance">
                        {quote ? (
                          <button type="button" className="gx-primary" disabled={Boolean(working[shot.id])} onClick={() => void render(shot, quote.credits)} data-testid="drawing-render">{working[shot.id] || `2 · Convert · ${quote.credits.toLocaleString()} credits`}</button>
                        ) : (
                          <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || !frame.reading} title={!frame.reading ? "Have the agent read the drawing first." : undefined} onClick={() => void quoteFrame(shot)} data-testid="drawing-price">{working[shot.id] || "2 · Price the conversion"}</button>
                        )}
                      </div>
                      {errors[shot.id] ? <p className="gx-gen-error" role="alert">{errors[shot.id]}</p> : null}
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
        <button type="button" className="gx-hbtn" onClick={() => { setBatch((b) => (b?.from === "picked" ? null : b)); setPicked(picked.length === shots.length ? [] : shots.map((s) => s.id)); }} data-testid="boards-select-all">{picked.length === shots.length ? "Clear" : "Select all"}</button>
        {batch?.from === "picked" ? (
          <>
            <button type="button" className="gx-primary" onClick={() => { void renderAll(); setPicked([]); }} data-testid="boards-render-selected">Storyboard {batch.ids.length} frames · {batch.credits.toLocaleString()} credits</button>
            <button type="button" className="gx-hbtn" onClick={() => setBatch(null)}>Change</button>
          </>
        ) : (
          <button type="button" className="gx-primary" disabled={!picked.length || Boolean(working.picked)} onClick={() => void priceMany(pickedShots, "picked")} data-testid="boards-price-selected">{working.picked || `Storyboard selected (${picked.length})`}</button>
        )}
        <button type="button" className="gx-hbtn" disabled={!pickedShots.some((s) => frameOf(s.id).takes.length)} title="Write a fresh prompt for each selected frame that has a picture." onClick={() => reviseAll(pickedShots)} data-testid="boards-revise-selected">Revise selected</button>
      </div>

      <section className="pd-frames" aria-label="Frames" data-testid="boards-frames" data-section="frames">
        {shots.map((shot) => {
          const frame = frameOf(shot.id);
          const shown = frame.selected ?? frame.takes[0]?.genId;
          const inFlight = (frame.pending ?? []).length > 0;
          const quote = quotes[shot.id] && quotes[shot.id].key === quoteKey(frame) ? quotes[shot.id] : null;
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
                <button type="button" className="gx-hbtn" aria-expanded={open === shot.id} onClick={() => { setOpen(open === shot.id ? null : shot.id); if (!frame.prompt.trim()) setFrame(shot.id, (f) => ({ ...f, prompt: shotPrompt(shot) })); }} data-testid="frame-prompt-toggle">Prompt</button>
                {frame.takes.length ? <button type="button" className="gx-hbtn" aria-expanded={shot.id in revising} onClick={() => setRevising((r) => { const next = { ...r }; if (shot.id in next) delete next[shot.id]; else next[shot.id] = ""; return next; })} data-testid="frame-revise">Revise</button> : null}
                {quote ? (
                  <button type="button" className="gx-primary" disabled={Boolean(working[shot.id])} onClick={() => void render(shot, quote.credits)} data-testid="frame-render">{working[shot.id] || `Render · ${quote.credits.toLocaleString()} credits`}</button>
                ) : (
                  <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || !frame.prompt.trim()} title={!frame.prompt.trim() ? "Write this frame’s prompt first." : undefined} onClick={() => void quoteFrame(shot)} data-testid="frame-price">{working[shot.id] || (frame.takes.length ? "Price another frame" : "Price this frame")}</button>
                )}
              </div>
              <AgentAction id={`frame-agent-${shot.id}`} secondary estimateLabel="Prompt with the agent" startLabel={(c) => `Write it · up to ${c} credits`}
                quote={q && q.input.kind === "frames" && q.input.shotId === shot.id ? q : null} busy={runs.busy} blocked={blocked}
                describe={(qq) => `The agent reads beat ${shot.number} · ${qq.value.calls} steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
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
                    <button type="button" className="gx-primary" disabled={Boolean(working[shot.id]) || !(revising[shot.id] ?? "").trim()} onClick={() => void revise(shot)} data-testid="frame-revise-price">{working[shot.id] || "Price the revision"}</button>
                    <button type="button" className="gx-hbtn" onClick={() => setRevising((r) => ({ ...r, [shot.id]: frame.prompt }))}>Start from the current prompt</button>
                    <button type="button" className="gx-hbtn" onClick={() => setRevising((r) => { const next = { ...r }; delete next[shot.id]; return next; })}>Cancel</button>
                  </div>
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
                        <AgentAction id={`frame-read-${shot.id}`} secondary estimateLabel={frame.reading ? "Read the drawing again" : "Have the agent read the drawing"} startLabel={(c) => `Read it · up to ${c} credits`}
                          quote={sketchQuote} busy={runs.busy} blocked={blocked ?? (!canSee ? `${model?.name ?? "This model"} cannot see images. Choose an agent model that can.` : null)}
                          describe={(qq) => `${qq.value.calls} agent steps with the drawing · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
                          onEstimate={() => void runs.estimate({ kind: "sketch", model: model!.id, effort: agent.effort, shotId: shot.id, sketchAssetId: frame.sketch!.assetId })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
                        {activeSketch ? <p className="gx-hint" role="status">{agentLabel(agentFamilyOf(activeSketch.model) ?? "claude")} is reading the drawing…</p> : null}
                      </>
                    ) : <p className="gx-hint">Upload your own line drawing and the agent reads its blocking; the rendered frame keeps your composition and choreography.</p>}
                  </div>
                </div>
              ) : null}
              {errors[shot.id] ? <p className="gx-gen-error" role="alert" data-testid="frame-error">{errors[shot.id]}</p> : null}
            </article>
          );
        })}
      </section>
      {onRig ? <div className="pd-next"><button type="button" className="gx-primary" disabled={!rendered} onClick={onRig} data-testid="boards-to-rig">Take the frames to Rig ›</button></div> : null}
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}{editor.notice ? ` · ${editor.notice}` : ""}</p>
    </div>
  );
}
