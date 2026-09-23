"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { useRig } from "@/components/workspace/rig/RigProvider";
import { addInput, branchFromTake, buildFromBoards, removeInput, setFirstFrame } from "@/lib/production/rig-build";
import { ENGINE_PROMPT_LIMIT, RIG_PROMPT_LIMIT, renderPromptFor, shotRenderPrompt, textKey } from "@/lib/production/rig-prompt";
import { entryAsset } from "@/lib/production/sequence";
import type { Asset } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { shotEngines } from "@/lib/workspace/engines";
import { useProjectLibrary } from "@/lib/workspace/library";
import { shotInputs, shotPreviewAsset } from "@/lib/workspace/rig";
import type { RigShot } from "@/lib/workspace/shots";
import { useWorkspace } from "@/lib/workspace/state";
import { AgentAction } from "./AgentAction";
import { useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";

/** The shot's own prompt (20,000 characters) and, when what it sends is over the engine's limit, the agent's condensation. */
export function ShotPrompt({ shot, locked }: { shot: RigShot; locked: boolean }) {
  const rig = useRig();
  const node = rig.selectedNode!;
  const project = rig.project!;
  const [error, setError] = useState<string | null>(null);
  const text = node.text ?? "";
  const full = useMemo(() => shotRenderPrompt(node, project), [node, project]);
  const render = renderPromptFor(node, project);
  return (
    <div className="pxw-insp-fieldcard" data-section="prompt" data-testid="rig-prompt">
      <div className="pxw-insp-fieldcard-head"><span>Prompt</span><span>{text.length.toLocaleString()} / {RIG_PROMPT_LIMIT.toLocaleString()}</span></div>
      <textarea aria-label="Shot prompt" rows={8} maxLength={RIG_PROMPT_LIMIT} value={text} disabled={locked} placeholder="Everything this shot should be — up to 20,000 characters."
        onChange={(e) => setError(rig.patchShot(shot.id, { prompt: e.target.value }))} data-testid="rig-prompt-input" />
      {error ? <p className="pxw-insp-error" role="alert">{error}</p> : null}
      {render.prompt !== null && render.condensed ? <p className="pxw-inspector-note" data-testid="rig-condensed">Sends the agent’s condensed prompt ({render.prompt.length.toLocaleString()} characters) — edit the prompt and it asks again.</p> : null}
      {render.prompt === null ? <Condense shotId={shot.id} full={full} /> : null}
    </div>
  );
}

function Condense({ shotId, full }: { shotId: string; full: string }) {
  const rig = useRig();
  const runs = useAgentRuns({ scope: rig.scope, projectId: rig.project!.id, save: rig.save });
  const agent = useAgentChoice(runs.models);
  const key = textKey(full.trim());
  const jobs = runs.jobs.filter((j) => j.kind === "condense" && j.nodeId === shotId);
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  const taken = useRef(new Set<string>());
  useEffect(() => {
    const done = jobs.find((j) => j.status === "succeeded" && j.result?.condensed?.key === key);
    if (!done?.result?.condensed || taken.current.has(done.id)) return;
    taken.current.add(done.id);
    rig.patchShot(shotId, { condensed: { key, text: done.result.condensed.text } });
  }, [jobs, key, rig, shotId]);
  const model = agent.model;
  const q = runs.quote && runs.quote.input.kind === "condense" && runs.quote.input.nodeId === shotId && runs.quote.input.model === model?.id ? runs.quote : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed." : active ? "The agent is condensing." : !model ? "Choose an agent in Brief & Script." : null;
  return (
    <div className="pxw-rig-condense" data-testid="rig-condense">
      <p className="pxw-inspector-note">This shot sends {full.trim().length.toLocaleString()} characters; engines take {ENGINE_PROMPT_LIMIT.toLocaleString()}. The agent condenses it and keeps every visual instruction.</p>
      <AgentAction id="rig-condense" secondary estimateLabel="Estimate the condensation" startLabel={(c) => `Condense · up to ${c} credits`} quote={q} busy={runs.busy} blocked={blocked}
        describe={(qq) => `${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
        onEstimate={() => void runs.estimate({ kind: "condense", model: model!.id, effort: agent.effort, nodeId: shotId })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
      {runs.error ? <p className="pxw-insp-error" role="alert">{runs.error}</p> : null}
    </div>
  );
}

/** The shot's inputs, with their pictures, the first-frame mark and unlink; then every way to add one. */
export function ShotInputs({ shot, locked }: { shot: RigShot; locked: boolean }) {
  const rig = useRig();
  const { toast } = useWorkspace();
  const project = rig.project!;
  const node = rig.selectedNode!;
  const inputs = useMemo(() => shotInputs(project, shot.id), [project, shot.id]);
  const library = useProjectLibrary(rig.scope, project.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const add = (asset: Asset, title?: string) => { const why = rig.apply((p) => addInput(p, shot.id, asset, title)); setProblem(why); if (!why) toast(`${title ?? asset.name} is an input of ${shot.name}`); };

  const others = project.nodes.filter((n) => n.id !== shot.id && (n.type === "scene" || n.type === "generate")).flatMap((n) => { const a = shotPreviewAsset(project, n.id); return a ? [{ node: n, asset: a }] : []; });
  const castAssets = project.assets.filter((a) => a.category === "Character" || a.category === "Element");
  const takes = library.items.filter((e) => (e.media === "image" || e.media === "video") && e.url);
  const upload = async (file: File) => {
    setBusy("Uploading…"); setProblem(null);
    try {
      const uploaded = await uploadWorkbench(file, undefined, rig.scope);
      add({ id: uploaded.id, uploadId: uploaded.id, kind: file.type.startsWith("video/") ? "video" : "image", category: "Reference", name: file.name.slice(0, 200), url: uploaded.url, mime: uploaded.mime || file.type, description: `Reference for ${shot.name}`, prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
    } catch (cause) { setProblem(cause instanceof Error ? cause.message : "The reference could not be uploaded."); }
    finally { setBusy(""); }
  };

  return (
    <div data-section="inputs" data-testid="rig-inputs">
      {inputs.length ? inputs.map((row) => {
        const first = Boolean(row.asset && node.firstFrameId === row.asset.id);
        return (
          <div className="pxw-insp-row pxw-insp-row--input" key={row.id} data-testid="rig-input">
            <span className="pxw-insp-row-thumb pxw-insp-row-thumb--media" aria-hidden="true">{row.asset?.url && (row.asset.kind === "image" || row.asset.kind === "video") ? <LazyMedia url={row.asset.url} kind={row.asset.kind} alt="" className="gx-lazy" /> : null}</span>
            <span className="pxw-insp-row-text">
              <span className="pxw-insp-row-name">{row.name}</span>
              <span className="pxw-insp-row-kind">{first ? "First frame" : row.asset?.kind === "video" ? "Reference video" : row.asset ? "Reference image" : row.kind}</span>
            </span>
            <span className="pxw-insp-row-actions">
              {row.asset?.kind === "image" ? <button type="button" className="pxw-link-button" disabled={locked} aria-pressed={first} onClick={() => setProblem(rig.apply((p) => setFirstFrame(p, shot.id, first ? null : row.asset!.id)))}>{first ? "Unmark first frame" : "Make first frame"}</button> : null}
              <button type="button" className="pxw-link-button" disabled={locked} aria-label={`Unlink ${row.name}`} onClick={() => setProblem(rig.apply((p) => removeInput(p, shot.id, row.id)))}>Unlink</button>
            </span>
          </div>
        );
      }) : <p className="pxw-inspector-note" style={{ marginTop: 0 }}>Nothing is connected to this shot yet.</p>}
      {node.firstFrameId && inputs.length > 1 ? <p className="pxw-inspector-note">A first frame cannot be combined with reference images or videos: the engine treats them as separate modes.</p> : null}

      <div className="pxw-rig-add-inputs" data-testid="rig-add-inputs">
        <label className="pxw-btn pxw-btn--control pxw-rig-upload">
          {busy || "Upload a reference"}
          <input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm" disabled={locked || Boolean(busy)} aria-label={`Upload a reference for ${shot.name}`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        </label>
        <select aria-label="Add from the library" value="" disabled={locked || !takes.length} onChange={(e) => { const entry = takes.find((t) => t.take.id === e.target.value); if (entry) add(entryAsset(entry)); }} data-testid="rig-add-library">
          <option value="">{takes.length ? "From the library…" : "The library is empty"}</option>
          {takes.map((t) => <option key={t.take.id} value={t.take.id}>{t.take.name}</option>)}
        </select>
        <select aria-label="Add a previous shot" value="" disabled={locked || !others.length} onChange={(e) => { const o = others.find((x) => x.node.id === e.target.value); if (o) add(o.asset, `Shot · ${o.node.title}`); }} data-testid="rig-add-shot">
          <option value="">{others.length ? "A previous shot…" : "No other shot has a take yet"}</option>
          {others.map((o) => <option key={o.node.id} value={o.node.id}>{o.node.title}</option>)}
        </select>
        <select aria-label="Attach cast or an element" value="" disabled={locked || !castAssets.length} onChange={(e) => { const a = castAssets.find((x) => x.id === e.target.value); if (a) add(a, `${a.category} · ${a.name}`); }} data-testid="rig-add-cast">
          <option value="">{castAssets.length ? "Cast & elements…" : "No cast built yet"}</option>
          {castAssets.map((a) => <option key={a.id} value={a.id}>{a.category === "Character" ? "Cast" : "Element"} · {a.name}</option>)}
        </select>
      </div>
      {problem ? <p className="pxw-insp-error" role="alert">{problem}</p> : null}
    </div>
  );
}

/** "Build another rig" from a take: a new shot with the same prompt and engine, the take as its input. */
export function BranchFromTake({ shot, assetId }: { shot: RigShot; assetId: string }) {
  const rig = useRig();
  const { toast } = useWorkspace();
  const asset = rig.project!.assets.find((a) => a.id === assetId);
  if (!asset || (asset.kind !== "image" && asset.kind !== "video")) return null;
  return (
    <button type="button" className="pxw-link-button" onClick={() => { const why = rig.apply((p) => branchFromTake(p, shot.id, asset), true); if (why) toast(why); else toast("A new rig refers to that take"); }} data-testid="rig-branch">
      Build another rig from this take
    </button>
  );
}

/** One shot per framed storyboard shot — the Rig's nodes for each frame. */
export function BuildFromBoards() {
  const rig = useRig();
  const { toast } = useWorkspace();
  const project = rig.project;
  if (!project) return null;
  const framed = Object.values(project.production?.boards?.frames ?? {}).filter((f) => f.selected ?? f.takes[0]).length;
  return (
    <div className="pxw-rig-build" data-section="rig-build">
      <button type="button" className="pxw-rig-add" disabled={!framed} title={!framed ? "Frame the shots in Storyboards first." : undefined}
        onClick={() => { let added = 0; const why = rig.apply((p) => { const out = buildFromBoards(p, shotEngines()[0].id); added = out.added; return out.project; }); toast(why ?? `${added} shots built from Storyboards`); }} data-testid="rig-from-boards">
        Build from Storyboards{framed ? ` · ${framed} framed` : ""}
      </button>
    </div>
  );
}
