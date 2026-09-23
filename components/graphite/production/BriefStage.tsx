"use client";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScriptPanel } from "@/components/workbench/ScriptPanel";
import { DevelopmentPanel } from "@/components/workbench/DevelopmentPanel";
import { applyDevelopment } from "@/lib/workbench/development-apply";
import { developmentSourceHash } from "@/lib/workbench/development-client";
import { sourceCanonical } from "@/lib/workbench/development-types";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { sha256Hex } from "@/lib/production/hash";
import type { DevelopmentJob } from "@/lib/workbench/development-types";
import type { ScreenplayImport, ScriptScene } from "@/lib/workbench/screenplay";
import { buildScreenplayNodes } from "@/lib/workbench/screenplay-nodes";
import type { Asset } from "@/lib/workbench/studio";
import { uploadWorkbench } from "@/lib/workbench/upload";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { useWorkspace } from "@/lib/workspace/state";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { SECTION_EVENT } from "@/lib/shell/production-tools";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";

export const PROMPT_LIMIT = 30_000;
export const NOTES_LIMIT = 5_000;
const STAGE: Record<string, string> = { draft: "drafting", critique: "critiquing the draft", refine: "refining", complete: "finishing" };


/**
 * Production › Brief & Script (owner's brief, 23 September): a prompt box the
 * chosen agent takes in and writes a script from; the script is offered for
 * review, and redrafted from the director's notes until they approve it. The
 * script editor (import, hand edits, scene review) sits beside it.
 */
export function BriefStage({ projectId, scope, onBeats }: { projectId: string; scope: string; onBeats?: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the brief" /></div>;
  return <BriefBody editor={editor} scope={scope} onBeats={onBeats} />;
}

function BriefBody({ editor, scope, onBeats }: { editor: ReturnType<typeof useDraftEditor>; scope: string; onBeats?: () => void }) {
  const p = editor.project!;
  const { toast, go } = useWorkspace();
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  const agent = useAgentChoice(runs.models);
  const [tab, setTab] = useState<"write" | "script">("write");
  const [notes, setNotes] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [full, setFull] = useState<Record<string, DevelopmentJob>>({});
  const [approvedHash, setApprovedHash] = useState<string | null>(null);
  const latest = useRef(p);
  useEffect(() => { latest.current = p; }, [p]);

  /* The Library's tools land on a section; the editor's live on the other tab. */
  useEffect(() => {
    const onSection = (event: Event) => { const section = (event as CustomEvent<string>).detail; if (section === "editor") setTab("script"); else if (section === "prompt" || section === "review") setTab("write"); };
    window.addEventListener(SECTION_EVENT, onSection);
    return () => window.removeEventListener(SECTION_EVENT, onSection);
  }, []);
  useStageFacts("brief", p);

  const drafts = useMemo(() => runs.jobs.filter((job) => job.kind === "write"), [runs.jobs]);
  const finished = drafts.filter((job) => job.status === "succeeded");
  const active = drafts.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const failed = drafts[0] && (drafts[0].status === "failed" || drafts[0].status === "uncertain") ? drafts[0] : null;
  const shownId = viewing && finished.some((job) => job.id === viewing) ? viewing : finished[0]?.id ?? null;
  const shownListed = finished.find((job) => job.id === shownId) ?? null;
  const shown = shownListed?.result?.script ? shownListed : shownId ? full[shownId] ?? null : null;
  const draftNumber = (job: DevelopmentJob) => finished.length - finished.findIndex((j) => j.id === job.id);

  /* An older draft is listed without its script; read it when opened. */
  useEffect(() => {
    if (!shownId || shownListed?.result?.script || full[shownId]) return;
    let alive = true;
    void runs.load(shownId).then((job) => { if (alive) setFull((old) => ({ ...old, [job.id]: job })); }).catch(() => undefined);
    return () => { alive = false; };
  }, [shownId, shownListed, full, runs]);

  const script = p.script ?? "";
  useEffect(() => { let alive = true; void sha256Hex(script).then((h) => { if (alive) setApprovedHash(h); }); return () => { alive = false; }; }, [script]);
  const approval = p.production?.scriptApproval;
  const approved = Boolean(approval && approvedHash && approval.sha256 === approvedHash && script.trim());

  const model = agent.model;
  const quote = runs.quote;
  const quoteFits = quote && quote.input.model === model?.id && quote.input.effort === agent.effort;
  const writeQuote = quoteFits && quote.input.kind === "write" && !quote.input.fromJobId ? quote : null;
  const redraftQuote = quoteFits && quote.input.kind === "write" && quote.input.fromJobId === shown?.id && quote.input.instructions === notes.trim() ? quote : null;
  const blocked = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : active ? "The agent is writing." : !model ? "Choose an agent above." : null;
  const writeBlocked = blocked ?? (!p.brief.trim() ? "Write what we are making first." : null);
  const redraftBlocked = blocked ?? (!notes.trim() ? "Write your notes for the redraft." : null);

  const approve = async (text: string, source: "agent" | "hand", jobId?: string) => {
    const sha256 = await sha256Hex(text);
    editor.change((old) => ({ ...old, script: text, scriptSource: source === "agent" ? undefined : old.scriptSource, scriptReviews: source === "agent" ? {} : old.scriptReviews,
      production: { ...old.production, scriptApproval: { at: new Date().toISOString(), source, sha256, ...(jobId ? { jobId } : {}) } } }));
    if (await editor.ensureSaved()) toast(source === "agent" ? "Script approved — it is now the project’s script" : "Script approved as written");
    else toast("Approved locally; the project is not saved yet.");
  };

  async function importScreenplay(file: File, result: ScreenplayImport) {
    const current = latest.current;
    if (current.assets.length >= PROJECT_LIMITS.assets) throw new Error("The asset library is full. Make space for the original screenplay first.");
    const uploaded = await uploadWorkbench(file, undefined, scope);
    const adfilm = current.scriptFormat === "adfilm";
    const asset: Asset = { id: uploaded.id, uploadId: uploaded.id, name: file.name.slice(0, 200), kind: "document", category: adfilm ? "Ad-film script" : "Screenplay", url: uploaded.url, mime: uploaded.mime || file.type, description: adfilm ? "Original ad-film script source" : "Original screenplay source", prompt: "", status: "Draft", version: 1, locked: false, refs: [] };
    editor.change((old) => ({ ...old, script: result.text, scriptReviews: {}, assets: [...old.assets, asset],
      scriptSource: { assetId: asset.id, filename: asset.name, sha256: result.sha256, pages: result.pages, importedAt: new Date().toISOString(), edited: false, acknowledgedEmptyPages: result.emptyPages, ocr: result.ocr } }));
    if (!(await editor.ensureSaved())) throw new Error("The source uploaded, but the project is not saved yet. Retry this import to save it without uploading again.");
  }
  /* The agentic script breakdown (the Studio's own panel): its scenes can go to the Rig; the same run becomes the beat sheet in Beats. */
  async function applyBreakdown(job: DevelopmentJob, choice: { idea: number } | { scenes: string[] }) {
    const current = latest.current;
    if (job.projectId !== current.id) throw new Error("Return to the project that created this result.");
    if ((await developmentSourceHash(current, job.kind)) !== job.sourceHash) throw new Error("The script changed after this breakdown. Review the saved result or break it down again.");
    if (sourceCanonical(latest.current, job.kind) !== sourceCanonical(current, job.kind)) throw new Error("The project changed while checking the result. Try again.");
    editor.change((old) => applyDevelopment(old, job, choice));
    if (!(await editor.ensureSaved())) throw new Error("The result was added locally, but is not saved yet.");
    toast("idea" in choice ? "Idea added to the creative direction" : "Scene breakdown added to the Rig");
  }
  async function buildScenes(scenes: ScriptScene[]) {
    try {
      const nodes = buildScreenplayNodes(latest.current, scenes);
      editor.change((old) => ({ ...old, nodes: [...old.nodes, ...nodes] }));
      if (!(await editor.ensureSaved())) throw new Error("The scene nodes were added locally, but are not saved yet.");
      toast(`${nodes.length} scene nodes added to Rig`);
      go("particl", "rig");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not build these scenes."); }
  }

  const quoteLine = (q: NonNullable<typeof quote>) => `${q.value.calls} agent steps — draft, critique, refine · ${thinkingModelName(q.input.model)} · up to ${q.value.estimateCredits.toLocaleString()} credits${q.value.estimateUsd != null ? ` · $${q.value.estimateUsd.toFixed(4)} ceiling` : ""}`;

  return (
    <div className="pd-stage gx-enter" data-testid="brief-stage">
      <div className="gx-seg gx-seg--sm pd-tabs" role="tablist" aria-label="Brief & Script">
        <button type="button" role="tab" className="gx-seg-btn" aria-selected={tab === "write"} onClick={() => setTab("write")} data-testid="brief-tab-write"><span>Brief</span></button>
        <button type="button" role="tab" className="gx-seg-btn" aria-selected={tab === "script"} onClick={() => setTab("script")} data-testid="brief-tab-script"><span>Script editor</span></button>
      </div>

      {runs.pending ? (
        <div className="gx-gen-card pd-recover" role="alert" data-testid="agent-recover">
          <p className="gx-hint">An earlier {runs.pendingInput?.kind === "write" ? "script" : "agent"} request was sent but not confirmed. Recovering it re-reads that exact request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={Boolean(runs.busy)} onClick={() => void runs.start()}>{runs.busy || "Recover the request"}</button>
        </div>
      ) : null}
      {runs.error ? <p className="gx-gen-error" role="alert" data-testid="agent-error">{runs.error}</p> : null}

      {tab === "write" ? (
        <>
          <section className="gx-gen-card" aria-label="The brief" data-testid="brief-prompt" data-section="prompt">
            <div className="pd-row-head">
              <span className="gx-eyebrow" data-functional-label="">The brief</span>
              <span className="gx-spacer" />
              <div className="gx-seg gx-seg--sm" role="radiogroup" aria-label="Script format">
                {(["screenplay", "adfilm"] as const).map((format) => (
                  <button key={format} type="button" role="radio" className="gx-seg-btn" aria-checked={(p.scriptFormat ?? "screenplay") === format} onClick={() => editor.change((old) => ({ ...old, scriptFormat: format }))}><span>{format === "screenplay" ? "Screenplay" : "Ad film"}</span></button>
                ))}
              </div>
            </div>
            <label className="gx-gen-row">
              <span className="gx-eyebrow" data-functional-label="">What are we making?</span>
              <textarea className="gx-textarea pd-prompt" aria-label="What are we making?" maxLength={PROMPT_LIMIT} value={p.brief} placeholder="Start with a thought, a story, a client brief — as much or as little as you have." onChange={(e) => { const value = e.target.value; editor.change((old) => ({ ...old, brief: value })); }} data-testid="brief-prompt-input" />
            </label>
            <span className="gx-hint pd-count">{p.brief.length.toLocaleString()} / {PROMPT_LIMIT.toLocaleString()}</span>
            {(["audience", "deliverables", "direction"] as const).map((field) => (
              <label key={field} className="gx-gen-row">
                <span className="gx-eyebrow" data-functional-label="">{field === "direction" ? "Creative direction" : field === "deliverables" ? "Deliverables" : "Audience"}</span>
                <textarea className="gx-textarea pd-small" aria-label={field === "direction" ? "Creative direction" : field === "deliverables" ? "Deliverables" : "Audience"} value={p[field]} maxLength={field === "direction" ? 30000 : 10000} onChange={(e) => { const value = e.target.value; editor.change((old) => ({ ...old, [field]: value })); }} data-testid={`brief-${field}`} />
              </label>
            ))}
          </section>

          <section className="gx-gen-card pd-develop" aria-label="Develop with an agent" data-testid="brief-develop" data-section="develop">
            <div className="gx-gen-row">
              <span className="gx-eyebrow" data-functional-label="">Develop with an agent</span>
              <p className="gx-hint">The agent reads everything above — what we are making, the audience, the deliverables and the direction — and takes it to the next step: a full script, drafted, critiqued and refined, for your review.</p>
            </div>
            <AgentBar bare models={runs.models} agent={agent} loaded={runs.loaded} disabled={Boolean(active) || Boolean(runs.busy)} />
            <div className="gx-gen-enhance">
              {writeQuote ? (
                <>
                  <button type="button" className="gx-primary" disabled={Boolean(runs.busy) || Boolean(writeBlocked)} onClick={() => void runs.start()} data-testid="brief-write">{runs.busy || `Write the script · up to ${writeQuote.value.estimateCredits.toLocaleString()} credits`}</button>
                  <button type="button" className="gx-hbtn" onClick={runs.clearQuote}>Change</button>
                  <span className="gx-hint" data-testid="brief-quote">{quoteLine(writeQuote)}</span>
                </>
              ) : (
                <button type="button" className="gx-primary" disabled={Boolean(runs.busy) || Boolean(writeBlocked)} aria-describedby={writeBlocked ? "brief-write-blocked" : undefined}
                  onClick={() => void runs.estimate({ kind: "write", model: model!.id, effort: agent.effort })} data-testid="brief-estimate">{runs.busy || (finished.length ? "Develop a fresh script with the agent" : "Develop with an agent")}</button>
              )}
              {writeBlocked && !writeQuote ? <span className="gx-reason" id="brief-write-blocked" data-testid="brief-write-blocked">{writeBlocked}</span> : null}
            </div>
          </section>

          {active ? (
            <section className="gx-gen-card pd-progress" role="status" aria-label="The agent is writing" data-testid="brief-progress">
              <span className="gx-eyebrow" data-functional-label="">{agentLabel(agentFamilyOf(active.model) ?? "claude")} is {STAGE[active.currentStage] ?? "writing"}</span>
              <div className="pd-meter" aria-hidden="true"><span style={{ width: `${Math.round(((active.completedSteps + 0.5) / Math.max(1, active.totalSteps)) * 100)}%` }} /></div>
              <span className="gx-hint">Step {Math.min(active.completedSteps + 1, active.totalSteps)} of {active.totalSteps} · {thinkingModelName(active.model)} · reserved up to {active.estimateCredits.toLocaleString()} credits</span>
            </section>
          ) : failed && !shown ? <p className="gx-gen-error" role="alert" data-testid="brief-failed">{failed.error ?? "The agent could not finish this script."}</p> : null}

          {shown?.result?.script ? (
            <section className="gx-gen-card pd-review" aria-label="Review the script" data-testid="brief-review" data-section="review">
              <div className="pd-row-head">
                <span className="gx-eyebrow" data-functional-label="">Review · Draft {draftNumber(shown)}</span>
                <span className="gx-spacer" />
                {finished.length > 1 ? (
                  <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Drafts">
                    {[...finished].reverse().map((job, i) => <button key={job.id} type="button" role="tab" className="gx-seg-btn" aria-selected={job.id === shown.id} onClick={() => setViewing(job.id)}><span>{i + 1}</span></button>)}
                  </div>
                ) : null}
              </div>
              <h2 className="gx-workflow-title" data-testid="brief-draft-title">{shown.result.script.title}</h2>
              <p className="gx-hint" data-testid="brief-logline">{shown.result.script.logline}</p>
              <pre className="pd-screenplay" tabIndex={0} aria-label="Script" data-testid="brief-screenplay">{shown.result.script.text}</pre>
              {shown.result.script.notes.length || shown.result.assumptions.length ? (
                <div className="pd-notes">
                  <span className="gx-eyebrow" data-functional-label="">The agent’s notes</span>
                  <ul>{shown.result.script.notes.map((n, i) => <li key={`n${i}`}>{n}</li>)}{shown.result.assumptions.map((n, i) => <li key={`a${i}`} className="pd-assume">Assumed: {n}</li>)}</ul>
                </div>
              ) : null}
              <p className="gx-hint">{thinkingModelName(shown.model)} · {shown.credits != null ? `${shown.credits.toLocaleString()} credits` : "settling"}{shown.instructions ? ` · redrafted from: “${shown.instructions.slice(0, 120)}${shown.instructions.length > 120 ? "…" : ""}”` : ""}</p>

              <div className="gx-gen-enhance">
                {approved && approval?.jobId === shown.id ? (
                  <>
                    <span className="gx-badge gx-badge--new" data-testid="brief-approved">Approved</span>
                    {onBeats ? <button type="button" className="gx-primary" onClick={onBeats} data-testid="brief-to-beats">Break it into beats ›</button> : null}
                  </>
                ) : (
                  <button type="button" className="gx-primary" onClick={() => void approve(shown.result!.script!.text, "agent", shown.id)} data-testid="brief-approve">Approve this script</button>
                )}
              </div>

              <label className="gx-gen-row pd-redraft">
                <span className="gx-eyebrow" data-functional-label="">Not there yet? Notes for the next draft</span>
                <textarea className="gx-textarea pd-small" maxLength={NOTES_LIMIT} value={notes} placeholder="What should change — a scene, a character’s voice, the ending, the length…" onChange={(e) => setNotes(e.target.value)} data-testid="brief-notes" />
              </label>
              <div className="gx-gen-enhance">
                {redraftQuote ? (
                  <>
                    <button type="button" className="gx-primary" disabled={Boolean(runs.busy) || Boolean(redraftBlocked)} onClick={() => void runs.start().then(() => setNotes(""))} data-testid="brief-redraft">{runs.busy || `Redraft · up to ${redraftQuote.value.estimateCredits.toLocaleString()} credits`}</button>
                    <button type="button" className="gx-hbtn" onClick={runs.clearQuote}>Change</button>
                    <span className="gx-hint" data-testid="brief-redraft-quote">{quoteLine(redraftQuote)}</span>
                  </>
                ) : (
                  <button type="button" className="gx-hbtn" disabled={Boolean(runs.busy) || Boolean(redraftBlocked)} aria-describedby={redraftBlocked ? "brief-redraft-blocked" : undefined}
                    onClick={() => void runs.estimate({ kind: "write", model: model!.id, effort: agent.effort, fromJobId: shown.id, instructions: notes.trim() })} data-testid="brief-redraft-estimate">Estimate the redraft</button>
                )}
                {redraftBlocked && !redraftQuote ? <span className="gx-reason" id="brief-redraft-blocked" data-testid="brief-redraft-blocked">{redraftBlocked}</span> : null}
              </div>
            </section>
          ) : !active && !finished.length ? (
            <p className="gx-empty" data-testid="brief-empty" data-section="review">The agent’s drafts appear here for review. Approve one, or send notes for another draft until it is right.</p>
          ) : null}
        </>
      ) : (
        <div className="pd-editor" data-section="editor">
          <div className="gx-gen-card pd-editor-head">
            <p className="gx-hint">{approved ? `Approved ${approval?.source === "agent" ? "from the agent’s draft" : "as written"}. Editing it here asks for approval again.` : script.trim() ? "This script is not approved yet." : "Write, paste or import a script here — or let the agent write one."}</p>
            {!approved && script.trim() ? <button type="button" className="gx-primary" onClick={() => void approve(script, "hand")} data-testid="brief-approve-hand">Approve the script as written</button> : null}
            {approved && onBeats ? <button type="button" className="gx-primary" onClick={onBeats}>Break it into beats ›</button> : null}
          </div>
          <div className="pxw gx-legacy"><div className="ps">
            <ScriptPanel embedded key={p.id} project={p}
              development={<DevelopmentPanel key={p.id + "-" + (p.scriptFormat || "screenplay")} project={p} kind={p.scriptFormat || "screenplay"} scope={scope} enabled models={[]} onSave={editor.ensureSaved} onApply={applyBreakdown} />}
              onScript={(value) => editor.change((old) => ({ ...old, script: value, scriptSource: old.scriptSource ? { ...old.scriptSource, edited: true } : undefined }))}
              onFormat={(value) => editor.change((old) => ({ ...old, scriptFormat: value }))}
              onImport={importScreenplay}
              onReview={(id, review) => editor.change((old) => ({ ...old, scriptReviews: { ...old.scriptReviews, [id]: review } }))}
              onBuild={(scenes) => void buildScenes(scenes)} />
          </div></div>
        </div>
      )}
      <p className="gx-hint pd-save" role="status" data-testid="brief-save">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}</p>
    </div>
  );
}
