"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentAttachments } from "./use-agent-attachments";
import { PromptAttach } from "@/components/PromptAttach";
import { hasFiles } from "@/lib/drop";
import { thinkingModelName } from "@/components/atomik/ModelPicker";
import { agentFamilyOf, agentLabel } from "@/lib/production/agent";
import { BEAT_LIMITS, BEAT_SOURCE_CHARS, beatCount, beatSheetFrom, move, newBeat, newScene, newShot, shotCount, type BeatScene, type BeatSheet, type BeatShot, type BeatSource } from "@/lib/production/beats";
import { sha256Hex } from "@/lib/production/hash";
import type { DevelopmentJob, DevelopmentScene } from "@/lib/workbench/development-types";
import { useDraftEditor } from "@/lib/workspace/use-draft-editor";
import { useWorkspace } from "@/lib/workspace/state";
import { DraftGate } from "@/components/workspace/spec/tools/DraftStatus";
import { AgentAction } from "./AgentAction";
import { BeatGraph } from "./BeatGraph";
import { AgentBar, useAgentChoice } from "./AgentBar";
import { useAgentRuns } from "./use-agent-runs";
import { useStageFacts } from "./use-stage-facts";

const STAGE: Record<string, string> = { draft: "breaking it down", critique: "checking the breakdown", refine: "refining the beats", complete: "finishing" };
/** Runs that fill the beat sheet: a breakdown of the script, or the summary of an uploaded beat sheet. */
const BREAKDOWN = new Set(["screenplay", "adfilm", "beatsheet"]);
const SCRIPT_BREAKDOWN = new Set(["screenplay", "adfilm"]);
const VIEW_KEY = "particl.beats.view";
/** A beat board's acts, like a Final Draft beat board: the first quarter is Act One, the last quarter Act Three, unless a scene says otherwise. */
const ACTS = [{ n: 1 as const, label: "Act One" }, { n: 2 as const, label: "Act Two" }, { n: 3 as const, label: "Act Three" }];

/**
 * Production › Beats (owner's brief, 23 September): the chosen agent breaks
 * the approved script into scenes, beats and shots — a beat sheet, like a
 * beat board — the director edits every beat and shot by hand, and the agent
 * redrafts the script to play the edited beats. The shots feed Storyboards.
 * Owner, 24 September: a beat sheet exported from Final Draft (a PDF) can be
 * uploaded instead — read in the browser, summarised into scenes and beats by
 * the agent — and the sheet can be seen as a graph as well as a board.
 */
export function BeatsStage({ projectId, scope, onBrief, onBoards }: { projectId: string; scope: string; onBrief: () => void; onBoards?: () => void }) {
  const editor = useDraftEditor(scope, projectId);
  if (editor.status !== "ready" || !editor.project) return <div className="pxw gx-legacy"><DraftGate editor={editor} label="the beats" /></div>;
  return <BeatsBody editor={editor} scope={scope} onBrief={onBrief} onBoards={onBoards} />;
}

function BeatsBody({ editor, scope, onBrief, onBoards }: { editor: ReturnType<typeof useDraftEditor>; scope: string; onBrief: () => void; onBoards?: () => void }) {
  const p = editor.project!;
  const { toast } = useWorkspace();
  const runs = useAgentRuns({ scope, projectId: p.id, save: editor.ensureSaved });
  const agent = useAgentChoice(runs.models);
  const attach = useAgentAttachments({ scope, project: p, change: editor.change, save: editor.ensureSaved, onChange: runs.clearQuote });
  useStageFacts("brief", p);
  const [scriptSha, setScriptSha] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [offered, setOffered] = useState<{ job: DevelopmentJob; scenes: DevelopmentScene[]; upload?: string } | null>(null);
  const [openScene, setOpenScene] = useState<string | null>(null);
  /* Board or graph, remembered on this device. The stage renders only after the project loads, never on the server. */
  const [view, setView] = useState<"board" | "graph">(() => { try { return localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "board"; } catch { return "board"; } });
  const chooseView = (next: "board" | "graph") => { setView(next); try { localStorage.setItem(VIEW_KEY, next); } catch { /* not remembered */ } };
  const [reading, setReading] = useState<{ page: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [importOver, setImportOver] = useState(false);
  const loading = useRef(new Set<string>());
  const script = p.script ?? "";
  const sheet = p.production?.beats ?? null;
  const approval = p.production?.scriptApproval;
  const source = p.production?.beatSource ?? null;
  useEffect(() => { let alive = true; void sha256Hex(script).then((h) => { if (alive) setScriptSha(h); }); return () => { alive = false; }; }, [script]);
  const approved = Boolean(approval && scriptSha && approval.sha256 === scriptSha && script.trim());
  /* A summary of an uploaded beat sheet does not come from the script, so editing the script never makes it stale. */
  const stale = Boolean(sheet && sheet.source !== "upload" && scriptSha && sheet.scriptSha256 !== scriptSha);

  const sourceName = source?.name;
  const breakdowns = useMemo(() => runs.jobs.filter((job) => BREAKDOWN.has(job.kind)), [runs.jobs]);
  const newestWrite = runs.jobs.find((job) => job.kind === "write") ?? null;
  const activeBreakdown = breakdowns.find((job) => job.status === "queued" || job.status === "running") ?? null;
  const activeWrite = runs.jobs.find((job) => job.kind === "write" && (job.status === "queued" || job.status === "running")) ?? null;
  const latest = breakdowns[0] ?? null;

  /* A finished breakdown this sheet has not taken yet: read every section, then fill an empty sheet or offer a replacement. */
  useEffect(() => {
    if (!latest || latest.status !== "succeeded" || sheet?.jobId === latest.id || offered?.job.id === latest.id || loading.current.has(latest.id) || !scriptSha) return;
    loading.current.add(latest.id);
    void (async () => {
      try {
        const scenes: DevelopmentScene[] = [];
        const total = latest.resultPage?.totalChunks ?? 1;
        for (let offset = 0; offset < total; offset++) {
          const part = offset === 0 && latest.result ? latest : await runs.load(latest.id, offset);
          scenes.push(...(part.result?.scenes ?? []));
        }
        const upload = latest.kind === "beatsheet" ? sourceName ?? "the beat sheet" : undefined;
        if (!sheet?.scenes.length) {
          editor.change((old) => ({ ...old, production: { ...old.production, beats: beatSheetFrom(scenes, scriptSha, latest.id, upload) } }));
          if (await editor.ensureSaved()) toast(upload ? `The agent summarised ${upload} into ${scenes.length} scenes` : `The agent broke the script into ${scenes.length} scenes`);
        } else setOffered({ job: latest, scenes, upload });
      } catch (error) { runs.setError(error instanceof Error ? error.message : "The breakdown could not be read."); }
      finally { loading.current.delete(latest.id); }
    })();
  }, [latest, sheet, offered, scriptSha, runs, editor, toast, sourceName]);

  const count = sheet?.scenes.length ?? 0;
  const actOf = (scene: BeatScene, si: number): 1 | 2 | 3 => scene.act ?? (si < Math.ceil(count / 4) ? 1 : count >= 3 && si >= count - Math.floor(count / 4) ? 3 : 2);
  const setSheet = (fn: (sheet: BeatSheet) => BeatSheet) => editor.change((old) => (old.production?.beats ? { ...old, production: { ...old.production, beats: { ...fn(old.production.beats), updatedAt: new Date().toISOString() } } } : old));
  const setScene = (id: string, fn: (scene: BeatScene) => BeatScene) => setSheet((s) => ({ ...s, scenes: s.scenes.map((scene) => (scene.id === id ? fn(scene) : scene)) }));
  const setShot = (sceneId: string, shotId: string, patch: Partial<BeatShot>) => setScene(sceneId, (scene) => ({ ...scene, shots: scene.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)) }));
  const startSheet = () => { if (!scriptSha) return; editor.change((old) => ({ ...old, production: { ...old.production, beats: { scriptSha256: scriptSha, updatedAt: new Date().toISOString(), scenes: [newScene()] } } })); };

  const model = agent.model;
  const kind = p.scriptFormat === "adfilm" ? "adfilm" : "screenplay";
  const q = runs.quote && runs.quote.input.model === model?.id && runs.quote.input.effort === agent.effort ? runs.quote : null;
  const breakdownQuote = q && SCRIPT_BREAKDOWN.has(q.input.kind) ? q : null;
  const importQuote = q && q.input.kind === "beatsheet" ? q : null;
  const redraftQuote = q && q.input.kind === "write" && q.input.fromBeats && (q.input.instructions ?? "") === notes.trim() ? q : null;
  const busyBlock = !runs.loaded ? "Reading the agent’s runs…" : runs.pending ? "An earlier agent request is unconfirmed. Recover it first." : activeBreakdown || activeWrite ? "The agent is working." : !model ? "Choose an agent above." : null;
  const blocked = busyBlock ?? (!script.trim() ? "There is no script yet." : null);
  const importBlocked = busyBlock ?? (reading ? "Reading the PDF…" : !source ? "Upload the beat sheet PDF first." : null);

  /* A Final Draft beat sheet, exported as a PDF: read in the browser (no upload of the file itself), kept on the project as text for the agent. */
  const readBeatSheet = async (file: File) => {
    setImportError(null);
    setReading({ page: 0, total: 0 });
    try {
      const { extractScreenplayPdf } = await import("@/lib/workbench/screenplay-pdf");
      const read = await extractScreenplayPdf(file, new AbortController().signal, (page, total) => setReading({ page, total }));
      const text = read.text.replace(/\f/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text.replace(/\s/g, "").length < 20) throw new Error("No text could be read from this PDF. Export the beat sheet from Final Draft as a PDF (not a scan or a photo) and upload that.");
      if (text.length > BEAT_SOURCE_CHARS) throw new Error(`This beat sheet is ${text.length.toLocaleString("en-US")} characters; the limit is ${BEAT_SOURCE_CHARS.toLocaleString("en-US")}. Nothing was uploaded.`);
      const beatSource: BeatSource = { name: file.name.slice(0, 300), sha256: read.sha256, pages: read.pages.length, text, at: new Date().toISOString() };
      runs.clearQuote();
      editor.change((old) => ({ ...old, production: { ...old.production, beatSource } }));
      await editor.ensureSaved();
    } catch (error) { setImportError(error instanceof Error ? error.message : "The PDF could not be read."); }
    finally { setReading(null); }
  };
  /* The newest draft came from these beats and is not the approved script yet: send the director to review it. */
  const lastRedraft = newestWrite && newestWrite.source === "beats" && newestWrite.status === "succeeded" && approval?.jobId !== newestWrite.id ? newestWrite : null;

  /* One scene opened to edit: its heading, act, summary, beats and shots. The board opens it in place; the graph beside the graph. */
  const sceneEditor = (scene: BeatScene, si: number) => (
            <article key={scene.id} className="gx-gen-card pd-scene pd-scene--open" data-testid="beat-scene" data-act={actOf(scene, si)} aria-label={scene.heading || `Scene ${si + 1}`}>
              <div className="pd-row-head">
                <span className="pd-scene-n" aria-hidden="true">{String(si + 1).padStart(2, "0")}</span>
                <input className="gx-field pd-scene-heading" aria-label={`Scene ${si + 1} heading`} value={scene.heading} maxLength={BEAT_LIMITS.heading} placeholder="INT. LOCATION - TIME" onChange={(e) => { const v = e.target.value; setScene(scene.id, (s) => ({ ...s, heading: v })); }} />
                <select className="pd-act-select" aria-label={`Scene ${si + 1} act`} value={actOf(scene, si)} onChange={(e) => { const act = Number(e.target.value) as 1 | 2 | 3; setScene(scene.id, (s) => ({ ...s, act })); }}>
                  {ACTS.map((a) => <option key={a.n} value={a.n}>{a.label}</option>)}
                </select>
                <button type="button" className="gx-hbtn" onClick={() => setOpenScene(null)} data-testid="beat-close">Done</button>
                <div className="pd-order">
                  <button type="button" className="gx-hbtn" aria-label={`Move scene ${si + 1} up`} disabled={si === 0} onClick={() => setSheet((s) => ({ ...s, scenes: move(s.scenes, si, -1) }))}>↑</button>
                  <button type="button" className="gx-hbtn" aria-label={`Move scene ${si + 1} down`} disabled={si === count - 1} onClick={() => setSheet((s) => ({ ...s, scenes: move(s.scenes, si, 1) }))}>↓</button>
                  <button type="button" className="gx-hbtn" aria-label={`Delete scene ${si + 1}`} onClick={() => setSheet((s) => ({ ...s, scenes: s.scenes.filter((x) => x.id !== scene.id) }))}>Delete</button>
                </div>
              </div>
              <textarea className="gx-textarea pd-small" aria-label={`Scene ${si + 1} summary`} value={scene.summary} maxLength={BEAT_LIMITS.summary} placeholder="What this scene is for" onChange={(e) => { const v = e.target.value; setScene(scene.id, (s) => ({ ...s, summary: v })); }} />
              {scene.characters.length || scene.locations.length ? <p className="gx-hint pd-cast-line">{[scene.characters.join(", "), scene.locations.join(", ")].filter(Boolean).join(" · ")}</p> : null}

              <div className="pd-beats" role="group" aria-label={`Scene ${si + 1} beats`}>
                <span className="gx-eyebrow" data-functional-label="">Beats</span>
                {scene.beats.map((beat, bi) => (
                  <div className="pd-beat" key={beat.id} data-testid="beat">
                    <span className="pd-beat-n" aria-hidden="true">{bi + 1}</span>
                    <textarea className="gx-textarea pd-beat-text" aria-label={`Scene ${si + 1} beat ${bi + 1}`} value={beat.text} maxLength={BEAT_LIMITS.beat} rows={2} onChange={(e) => { const v = e.target.value; setScene(scene.id, (s) => ({ ...s, beats: s.beats.map((b) => (b.id === beat.id ? { ...b, text: v } : b)) })); }} />
                    <div className="pd-order">
                      <button type="button" className="gx-hbtn" aria-label={`Move beat ${bi + 1} up`} disabled={bi === 0} onClick={() => setScene(scene.id, (s) => ({ ...s, beats: move(s.beats, bi, -1) }))}>↑</button>
                      <button type="button" className="gx-hbtn" aria-label={`Delete beat ${bi + 1}`} onClick={() => setScene(scene.id, (s) => ({ ...s, beats: s.beats.filter((b) => b.id !== beat.id) }))}>×</button>
                    </div>
                  </div>
                ))}
                <button type="button" className="gx-hbtn pd-add" disabled={scene.beats.length >= BEAT_LIMITS.beats} onClick={() => setScene(scene.id, (s) => ({ ...s, beats: [...s.beats, newBeat()] }))}>+ Beat</button>
              </div>

              <div className="pd-shots" role="group" aria-label={`Scene ${si + 1} shots`}>
                <span className="gx-eyebrow" data-functional-label="">Shots</span>
                {scene.shots.map((shot, ti) => (
                  <div className="pd-shot" key={shot.id} data-testid="beat-shot">
                    <div className="pd-row-head">
                      <span className="pd-shot-n">{si + 1}.{ti + 1}</span>
                      <span className="gx-spacer" />
                      <label className="pd-seconds"><span className="gx-hint">Seconds</span><input className="gx-field" type="number" min={0.5} max={600} step={0.5} aria-label={`Shot ${si + 1}.${ti + 1} seconds`} value={shot.duration ?? ""} onChange={(e) => { const n = Number(e.target.value); setShot(scene.id, shot.id, { duration: e.target.value === "" || !Number.isFinite(n) ? undefined : Math.min(600, Math.max(0.5, n)) }); }} /></label>
                      <div className="pd-order">
                        <button type="button" className="gx-hbtn" aria-label={`Move shot ${si + 1}.${ti + 1} up`} disabled={ti === 0} onClick={() => setScene(scene.id, (s) => ({ ...s, shots: move(s.shots, ti, -1) }))}>↑</button>
                        <button type="button" className="gx-hbtn" aria-label={`Delete shot ${si + 1}.${ti + 1}`} onClick={() => setScene(scene.id, (s) => ({ ...s, shots: s.shots.filter((x) => x.id !== shot.id) }))}>×</button>
                      </div>
                    </div>
                    <textarea className="gx-textarea pd-beat-text" aria-label={`Shot ${si + 1}.${ti + 1} description`} value={shot.description} maxLength={BEAT_LIMITS.description} rows={2} placeholder="What the camera sees" onChange={(e) => setShot(scene.id, shot.id, { description: e.target.value })} />
                    <div className="pd-shot-fields">
                      {(["framing", "movement", "lighting", "sound"] as const).map((field) => (
                        <label key={field}><span className="gx-hint">{field.charAt(0).toUpperCase() + field.slice(1)}</span>
                          <input className="gx-field" aria-label={`Shot ${si + 1}.${ti + 1} ${field}`} value={shot[field]} maxLength={BEAT_LIMITS.field} onChange={(e) => setShot(scene.id, shot.id, { [field]: e.target.value })} />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <button type="button" className="gx-hbtn pd-add" disabled={scene.shots.length >= BEAT_LIMITS.shots} onClick={() => setScene(scene.id, (s) => ({ ...s, shots: [...s.shots, newShot()] }))} data-testid="add-shot">+ Shot</button>
              </div>
            </article>
  );

  return (
    <div className="pd-stage gx-enter" data-testid="beats-stage">
      <AgentBar models={runs.models} agent={agent} loaded={runs.loaded} disabled={Boolean(activeBreakdown || activeWrite) || Boolean(runs.busy)} />
      {runs.pending ? (
        <div className="gx-gen-card pd-recover" role="alert">
          <p className="gx-hint">An earlier agent request was sent but not confirmed. Recovering it re-reads that exact request; it is never sent twice.</p>
          <button type="button" className="gx-primary" disabled={Boolean(runs.busy)} onClick={() => void runs.start()}>{runs.busy || "Recover the request"}</button>
        </div>
      ) : null}
      {runs.error ? <p className="gx-gen-error" role="alert" data-testid="agent-error">{runs.error}</p> : null}

      <section className="gx-gen-card" aria-label="Break it down" data-testid="beats-breakdown" data-section="breakdown">
        <div className="pd-row-head">
          <span className="gx-eyebrow" data-functional-label="">Beat sheet</span>
          <span className="gx-spacer" />
          {sheet ? <span className="gx-hint" data-testid="beats-counts">{sheet.scenes.length} scenes · {beatCount(sheet)} beats · {shotCount(sheet)} shots</span> : null}
        </div>
        {!script.trim() ? (
          <div data-testid="beats-no-script">
            <p className="gx-hint">{sheet ? "There is no script yet: these beats " + (sheet.source === "upload" ? `came from ${sheet.sourceName ?? "an uploaded beat sheet"}.` : "were written by hand.") + " Write the script from them in Brief & Script." : "There is no script to break down yet. Write one with the agent — or paste or import one — in Brief & Script, or upload a beat sheet below."}</p>
            <button type="button" className="gx-primary" onClick={onBrief}>Open Brief & Script</button>
          </div>
        ) : null}
        {script.trim() ? <p className="gx-hint">
          {!approved ? "The script is not approved yet — you can break it down now, or approve it in Brief & Script first. " : ""}
          {!sheet ? `The agent reads the whole ${kind === "adfilm" ? "ad-film script" : "screenplay"} and returns every scene with its beats and the shots to film it.`
            : stale ? "The script changed after this breakdown. Break it down again, or keep editing these beats." : sheet.source === "upload" ? `The agent’s summary of ${sheet.sourceName ?? "an uploaded beat sheet"}, with your edits.` : sheet.jobId ? "From the agent’s breakdown of the current script, with your edits." : "Written by hand."}
        </p> : null}
        {script.trim() && !approved ? <button type="button" className="gx-hbtn" onClick={onBrief}>Approve the script in Brief & Script</button> : null}
        {activeBreakdown ? (
          <div className="pd-progress" role="status" data-testid="beats-progress">
            <span className="gx-eyebrow" data-functional-label="">{agentLabel(agentFamilyOf(activeBreakdown.model) ?? "claude")} is {activeBreakdown.kind === "beatsheet" && activeBreakdown.currentStage === "draft" ? "summarising the beat sheet" : STAGE[activeBreakdown.currentStage] ?? "working"}</span>
            <div className="pd-meter" aria-hidden="true"><span style={{ width: `${Math.round(((activeBreakdown.completedSteps + 0.5) / Math.max(1, activeBreakdown.totalSteps)) * 100)}%` }} /></div>
            <span className="gx-hint">Step {Math.min(activeBreakdown.completedSteps + 1, activeBreakdown.totalSteps)} of {activeBreakdown.totalSteps} · {thinkingModelName(activeBreakdown.model)}</span>
          </div>
        ) : latest && (latest.status === "failed" || latest.status === "uncertain") ? <p className="gx-gen-error" role="alert">{latest.error ?? "The breakdown could not finish."}</p> : null}
        {offered ? (
          <div className="pd-offer" role="status" data-testid="beats-offer">
            <p className="gx-hint">{offered.upload ? `The agent’s summary of ${offered.upload} is ready` : "A new breakdown is ready"}: {offered.scenes.length} scenes. Replacing the beat sheet discards your edits to it.</p>
            <button type="button" className="gx-primary" onClick={() => { const next = beatSheetFrom(offered.scenes, scriptSha!, offered.job.id, offered.upload); editor.change((old) => ({ ...old, production: { ...old.production, beats: next } })); setOffered(null); void editor.ensureSaved(); }} data-testid="beats-replace">Replace the beat sheet</button>
            <button type="button" className="gx-hbtn" onClick={() => { editor.change((old) => (old.production?.beats ? { ...old, production: { ...old.production, beats: { ...old.production.beats, jobId: offered.job.id, scriptSha256: scriptSha ?? old.production.beats.scriptSha256 } } } : old)); setOffered(null); }}>Keep mine</button>
          </div>
        ) : null}
        {script.trim() && (!sheet || stale || !activeBreakdown) ? (
          <AgentAction id="beats-breakdown" estimateLabel={sheet ? "Estimate a new breakdown" : "Estimate the breakdown"} startLabel={(c) => `Break it into beats · up to ${c} credits`}
            quote={breakdownQuote} busy={runs.busy} blocked={blocked} secondary={Boolean(sheet && !stale)}
            describe={(qq) => `${qq.value.chunks} ${qq.value.chunks === 1 ? "section" : "sections"} · ${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
            onEstimate={() => void runs.estimate({ kind, model: model!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
        ) : null}
        {!sheet ? <button type="button" className="gx-hbtn" onClick={startSheet} data-testid="beats-by-hand">Or write the beats by hand</button> : null}

        <div className="pd-import" data-testid="beats-import" data-drop={importOver || undefined}
          onDragOver={(e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setImportOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setImportOver(false); }}
          onDrop={(e) => { const file = Array.from(e.dataTransfer.files).find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)); setImportOver(false); if (!file) return; e.preventDefault(); if (!reading) void readBeatSheet(file); }}>
          <span className="gx-eyebrow" data-functional-label="">Upload a beat sheet</span>
          <p className="gx-hint">A beat sheet from Final Draft — its beat board or outline, exported as a PDF; choose it or drop it here. The PDF is read here in the browser, and the agent summarises it into scenes and beats{sheet ? "; you choose whether that replaces this sheet" : ""}.</p>
          <div className="pd-import-row">
            <button type="button" className="gx-hbtn" disabled={Boolean(reading)} onClick={() => fileInput.current?.click()} data-testid="beats-import-choose">
              {reading ? (reading.total ? `Reading page ${reading.page} of ${reading.total}…` : "Reading the PDF…") : source ? "Upload another PDF" : "Upload a beat sheet PDF"}
            </button>
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden data-testid="beats-import-file" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void readBeatSheet(file); }} />
            {source ? <span className="gx-hint" data-testid="beats-import-source">{source.name} · {source.pages} {source.pages === 1 ? "page" : "pages"} · {source.text.length.toLocaleString("en-US")} characters read</span> : null}
          </div>
          {importError ? <p className="gx-gen-error" role="alert" data-testid="beats-import-error">{importError}</p> : null}
          {source ? (
            <AgentAction id="beats-import" estimateLabel="Estimate the summary" startLabel={(c) => `Summarise into beats · up to ${c} credits`}
              quote={importQuote} busy={runs.busy} blocked={importBlocked} secondary={Boolean(sheet)}
              describe={(qq) => `${qq.value.calls} agent steps · ${thinkingModelName(qq.input.model)} · up to ${qq.value.estimateCredits.toLocaleString()} credits`}
              onEstimate={() => void runs.estimate({ kind: "beatsheet", model: model!.id, effort: agent.effort })} onStart={() => void runs.start()} onChange={runs.clearQuote} />
          ) : null}
        </div>
      </section>

      {sheet ? (
        <div className="pd-row-head" data-testid="beats-view">
          <span className="gx-eyebrow" data-functional-label="">{view === "graph" ? "Beat graph" : "Beat board"}</span>
          <span className="gx-spacer" />
          <div className="pd-view-toggle" role="radiogroup" aria-label="Show the beats as">
            <button type="button" role="radio" aria-checked={view === "board"} onClick={() => chooseView("board")} data-testid="beats-view-board">Board</button>
            <button type="button" role="radio" aria-checked={view === "graph"} onClick={() => chooseView("graph")} data-testid="beats-view-graph">Graph</button>
          </div>
        </div>
      ) : null}

      {sheet && view === "graph" ? (() => {
        const si = openScene ? sheet.scenes.findIndex((x) => x.id === openScene) : -1;
        return (
          <section className="pd-graph-layout" aria-label="Beat graph" data-section="graph">
            <BeatGraph sheet={sheet} projectId={p.id} openId={si >= 0 ? openScene : null} onOpen={setOpenScene} onReorder={(scenes) => setSheet((s) => ({ ...s, scenes }))}
              panel={si >= 0 ? sceneEditor(sheet.scenes[si], si) : null} />
            <button type="button" className="gx-hbtn pd-add" disabled={sheet.scenes.length >= BEAT_LIMITS.scenes} onClick={() => setSheet((s) => ({ ...s, scenes: [...s.scenes, newScene()] }))} data-testid="add-scene">+ Scene</button>
          </section>
        );
      })() : null}

      {sheet && view === "board" ? (
        <section className="pd-board" aria-label="Beat board" data-testid="beat-board" data-section="board">
          {ACTS.map((act) => {
            const inAct = sheet.scenes.map((scene, si) => ({ scene, si })).filter(({ scene, si }) => actOf(scene, si) === act.n);
            if (!inAct.length) return null;
            return (
              <div key={act.n} className="pd-act" data-act={act.n}>
                <div className="pd-act-head" data-testid="beat-act"><span className="pd-act-name">{act.label}</span><span className="gx-hint">Scenes {inAct[0].si + 1}{inAct.length > 1 ? `–${inAct[inAct.length - 1].si + 1}` : ""} · {inAct.reduce((n, x) => n + x.scene.shots.length, 0)} shots</span></div>
                <div className="pd-card-grid">
                  {inAct.map(({ scene, si }) => openScene === scene.id ? (
                    sceneEditor(scene, si)
                  ) : (
                    <button key={scene.id} type="button" className="pd-beat-card" data-testid="beat-scene" data-act={act.n} onClick={() => setOpenScene(scene.id)} aria-label={`Open scene ${si + 1}: ${scene.heading || "untitled"}`}>
                      <span className="pd-beat-card-head"><span className="pd-beat-card-title">{scene.heading || `Scene ${si + 1}`}</span><span className="pd-scene-n">{String(si + 1).padStart(2, "0")}</span></span>
                      {scene.summary ? <span className="pd-beat-card-text">{scene.summary}</span> : null}
                      {scene.beats.length ? <ul className="pd-beat-card-beats">{scene.beats.slice(0, 4).map((b) => <li key={b.id}>{b.text}</li>)}{scene.beats.length > 4 ? <li>+{scene.beats.length - 4} more</li> : null}</ul> : null}
                      <span className="pd-beat-card-foot">{scene.shots.length} {scene.shots.length === 1 ? "shot" : "shots"}{scene.characters.length ? ` · ${scene.characters.slice(0, 3).join(", ")}` : ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <button type="button" className="gx-hbtn pd-add" disabled={sheet.scenes.length >= BEAT_LIMITS.scenes} onClick={() => setSheet((s) => ({ ...s, scenes: [...s.scenes, newScene()] }))} data-testid="add-scene">+ Scene</button>
        </section>
      ) : null}

      {sheet ? (
        <section className="gx-gen-card" aria-label="Redraft the script" data-testid="beats-redraft" data-section="redraft">
          <span className="gx-eyebrow" data-functional-label="">Redraft the script from these beats</span>
          <p className="gx-hint">The agent rewrites the script so it plays this beat sheet — your edits, in this order — and the new draft goes to Brief & Script for your review.</p>
          <PromptAttach scope={scope} projectId={p.id} onAttach={attach.onAttach} label="Attach for the writer" testId="beats-notes-attach"><textarea className="gx-textarea pd-small" maxLength={5000} value={notes} placeholder="Anything else for the writer (optional)" onChange={(e) => setNotes(e.target.value)} data-testid="beats-notes" />{attach.chips}</PromptAttach>
          {activeWrite ? <p className="gx-hint" role="status" data-testid="beats-redraft-progress">{agentLabel(agentFamilyOf(activeWrite.model) ?? "claude")} is redrafting · step {Math.min(activeWrite.completedSteps + 1, activeWrite.totalSteps)} of {activeWrite.totalSteps}</p> : null}
          <AgentAction id="beats-redraft" estimateLabel="Estimate the redraft" startLabel={(c) => `Redraft the script · up to ${c} credits`} quote={redraftQuote} busy={runs.busy}
            blocked={blocked ?? (stale ? "Break the current script down first, or it is redrafted from beats of an older draft." : null)} secondary
            onEstimate={() => void runs.estimate({ kind: "write", model: model!.id, effort: agent.effort, fromBeats: true, ...(notes.trim() ? { instructions: notes.trim() } : {}), ...attach.input })}
            onStart={() => void runs.start().then(() => setNotes(""))} onChange={runs.clearQuote} />
          {lastRedraft && !activeWrite ? <button type="button" className="gx-hbtn" onClick={onBrief} data-testid="beats-review-redraft">A new draft is ready · review it in Brief & Script ›</button> : null}
        </section>
      ) : null}

      {sheet && onBoards ? (
        <div className="pd-next">
          <button type="button" className="gx-primary" disabled={!shotCount(sheet)} onClick={onBoards} data-testid="beats-to-boards">Storyboard these {shotCount(sheet)} shots ›</button>
        </div>
      ) : null}
      <p className="gx-hint pd-save" role="status">{editor.saveState}{editor.error ? ` — ${editor.error}` : ""}</p>
    </div>
  );
}
