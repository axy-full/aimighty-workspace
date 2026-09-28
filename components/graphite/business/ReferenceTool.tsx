"use client";
import { useMemo, useState } from "react";
import { AtomikRunDialog } from "@/components/workbench/AtomikRunDialog";
import { EMPTY_REFERENCE_AD, normalizeReferenceAd, referenceAdBinding, referenceAdOriginals, selectReferenceAd, type ReferenceAdConfig } from "@/lib/workbench/reference-ad";
import { REFERENCE_AD_LIMITATION, applyReferenceAdAnalysis, assertReferenceAnalysisSource, referenceAdAnalysisSchema, type ReferenceAdAnalysis } from "@/lib/workbench/reference-ad-analysis";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { aboutCredits, type OwnPage } from "@/lib/shell/business-own";
import { CardHead, Field, PicturePicker, Said, SaveLine, adoptEntry, briefOf, changeBrief, refreshLibrary, uploadToDraft, useLatest, useWork, type OwnEditor } from "./own-kit";
import { useOwnAgent } from "./use-own-agent";

const ASK = "Analyze the visible beats, framing, inferred pacing and colors of this reference ad. Propose an original matching direction for my supplied product and brand. Distinguish sampled evidence from inference.";

/**
 * Business › Reference: a video ad you own, chosen from this project (or
 * uploaded), with your notes and the direction to adapt — and, if you want
 * it, a review by a thinking model of twelve sampled stills (the existing
 * Atomik reference-ad analysis). The review is paid: the dialog shows its
 * approximate price before it runs, and its direction is applied only after
 * you have read and edited it. The original is never changed.
 */
export function ReferenceTool({ scope, editor, items, onOpen }: { scope: string; editor: OwnEditor; items: LibraryEntry[]; onOpen: (page: OwnPage) => void }) {
  const p = editor.project!;
  const latest = useLatest(p);
  const { toast } = useWorkspace();
  const brief = briefOf(p);
  const value: ReferenceAdConfig = brief.referenceAd ?? EMPTY_REFERENCE_AD;
  const originals = referenceAdOriginals(p);
  const selected = originals.find((o) => o.asset.id === value.assetId) ?? null;
  const work = useWork();
  const [picking, setPicking] = useState(!value.assetId);
  const [dialog, setDialog] = useState(false);
  const [chosenJob, setChosenJob] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const saved = Boolean(p.productionProjectId);
  const agent = useOwnAgent(scope, p.id, saved);
  const models = agent.data?.models.filter((m) => m.vision) ?? [];
  const setValue = (fn: (current: ReferenceAdConfig) => ReferenceAdConfig) =>
    changeBrief(editor, (b, project) => ({ ...b, referenceAd: fn(normalizeReferenceAd(project, b.referenceAd ?? EMPTY_REFERENCE_AD)) }));

  /* Every saved review of this very original: the one on the brief, then the agent's runs for this project. */
  const history = useMemo(() => {
    const found: ReferenceAdAnalysis[] = [];
    for (const job of agent.data?.jobs ?? []) {
      const parsed = referenceAdAnalysisSchema.safeParse(job.plan?.referenceAdAnalysis);
      if (parsed.success && parsed.data.projectId === p.id && parsed.data.jobId === job.id) found.push(parsed.data);
    }
    const all = [...(value.analysis ? [value.analysis] : []), ...found].filter((a) => {
      if (a.projectId !== p.id || a.evidence.source.assetId !== value.assetId) return false;
      try { assertReferenceAnalysisSource(p, a.evidence.source); return true; } catch { return false; }
    });
    return [...new Map(all.map((a) => [a.jobId, a])).values()];
  }, [agent.data, p, value.analysis, value.assetId]);
  const analysis = history.find((a) => a.jobId === chosenJob) ?? history[0] ?? null;
  const reviewed = analysis ? edits[analysis.jobId] ?? analysis.result.direction : "";
  /* A review in flight has no plan yet: it is known by the request this page sends. */
  const running = (agent.data?.jobs ?? []).find((job) => (job.status === "queued" || job.status === "running") && job.request === ASK) ?? null;
  const reviewing = Boolean(running);

  const choose = (assetId: string) => { setValue((current) => selectReferenceAd(latest.current, current, assetId)); setPicking(false); void editor.ensureSaved(); };
  const takeVideo = (entry: LibraryEntry) => {
    const asset = adoptEntry(editor, latest.current, entry, "Reference");
    if (!asset) { work.setError("The project’s asset library is full."); return; }
    /* Chosen once the draft holds the record (the adopt above is applied first). */
    changeBrief(editor, (b, project) => ({ ...b, referenceAd: selectReferenceAd(project, b.referenceAd ?? EMPTY_REFERENCE_AD, asset.id) }));
    setPicking(false);
    void editor.ensureSaved();
  };
  const uploadVideo = (file: File) => work.run("upload", async () => {
    if (!file.type.startsWith("video/")) throw new Error(`${file.name} is not a video.`);
    const asset = await uploadToDraft(scope, editor, latest.current, file, "Reference", "Reference ad original");
    changeBrief(editor, (b, project) => ({ ...b, referenceAd: selectReferenceAd(project, b.referenceAd ?? EMPTY_REFERENCE_AD, asset.id) }));
    setPicking(false);
    await editor.ensureSaved();
    refreshLibrary(scope, latest.current.id);
    return `${file.name} is the reference ad.`;
  });
  const openReview = () => work.run("prepare", async () => {
    if (!selected) throw new Error("Choose the reference video first.");
    if (!(await editor.ensureSaved())) throw new Error("Save this project before reviewing its reference.");
    assertReferenceAnalysisSource(latest.current, referenceAdBinding(latest.current, briefOf(latest.current).referenceAd)!);
    setDialog(true);
  });
  const apply = () => {
    if (!analysis) return;
    try {
      const next = applyReferenceAdAnalysis(latest.current, briefOf(latest.current).referenceAd ?? EMPTY_REFERENCE_AD, analysis, reviewed);
      changeBrief(editor, (b) => ({ ...b, referenceAd: next }));
      void editor.ensureSaved();
      work.setError("");
      toast("The reviewed direction is on the reference. Video briefs in Format carry it.");
    } catch (cause) { work.setError(cause instanceof Error ? cause.message : "The direction could not be applied."); }
  };
  const blocked = !selected ? "Choose the reference video first." : !saved ? "Save the project first: the review reads its saved brief." : !agent.data ? (agent.error ? null : "Reading the agent’s runs…")
    : !agent.data.configured || !models.length ? "No priced thinking model that reads images is set up for this workspace. Ask an admin to add one in Workspace › Engines." : reviewing ? "A review is running." : null;

  return (
    <div className="bo gx-enter" data-testid="reference-tool">
      <section className="gx-gen-card" aria-label="The reference video" data-testid="reference-pick">
        <CardHead label="The reference video"><span className="gx-hint">An ad you own or may use</span></CardHead>
        {selected ? (
          <figure className="bo-video">
            <video key={`${p.id}:${selected.asset.id}`} src={selected.original.url} controls playsInline preload="metadata" aria-label={`Reference ad: ${selected.asset.name}`} />
            <figcaption className="gx-hint" data-testid="reference-name">{selected.asset.name} · the original, unchanged</figcaption>
          </figure>
        ) : value.assetId ? <p className="gx-reason">The chosen video is no longer in this project. Choose another.</p> : null}
        <div className="gx-gen-enhance">
          <button type="button" className="gx-hbtn" aria-expanded={picking} onClick={() => setPicking(!picking)} data-testid="reference-choose">{selected ? "Change the video" : "Choose a video"}</button>
          {selected ? <button type="button" className="gx-hbtn" onClick={() => setValue((current) => selectReferenceAd(latest.current, current, undefined))}>Clear</button> : null}
        </div>
        {picking ? (<>
          {originals.length ? (
            <div className="gx-chips" role="group" aria-label="Project videos" data-testid="reference-originals">
              {originals.map(({ asset }) => <button key={asset.id} type="button" className="gx-chip bo-chip-long" aria-pressed={asset.id === value.assetId} onClick={() => choose(asset.id)}>{asset.name}</button>)}
            </div>
          ) : null}
          <PicturePicker items={items} kind="video" label="Library videos" chosen={selected ? [selected.asset.uploadId ?? selected.asset.generationId ?? selected.asset.id] : []} busy={work.busy === "upload"} onPick={takeVideo} onUpload={(f) => void uploadVideo(f)} testId="reference-picker" />
        </>) : null}
        <Field label="What works in it"><textarea className="gx-textarea bo-short" value={value.notes} maxLength={2000} placeholder="The opening, the pacing, the framing or the sound to learn from" onChange={(e) => { const notes = e.target.value; setValue((current) => ({ ...current, notes })); }} data-testid="reference-notes" /></Field>
        <Field label="The direction for your campaign"><textarea className="gx-textarea bo-short" value={value.direction} maxLength={6000} placeholder="What to adapt, and how your product and brand differ" onChange={(e) => { const direction = e.target.value; setValue((current) => ({ ...current, direction })); }} data-testid="reference-direction" /></Field>
        <div className="gx-gen-enhance"><button type="button" className="gx-hbtn" disabled={!value.direction.trim()} onClick={() => onOpen("format")}>Use it in a video brief</button></div>
      </section>

      <section className="gx-gen-card" aria-label="Review it with the agent" data-testid="reference-agent">
        <CardHead label="Review it with the agent"><span className="gx-hint">Paid · priced first</span></CardHead>
        <p className="gx-hint">{REFERENCE_AD_LIMITATION}</p>
        <div className="gx-gen-enhance">
          <button type="button" className="gx-primary" disabled={Boolean(blocked) || Boolean(work.busy)} aria-describedby={blocked ? "reference-blocked" : undefined} onClick={() => void openReview()} data-testid="reference-price">{work.busy === "prepare" ? "Preparing the original…" : "See the price"}</button>
        </div>
        {blocked ? <p className="gx-reason" id="reference-blocked" data-testid="reference-blocked">{blocked}</p> : null}
        <Said error={work.error} notice={work.notice} testId="reference" />
        {agent.error ? <div className="gx-retry" role="alert"><span className="gx-gen-error">{agent.error}</span><button type="button" className="gx-hbtn" onClick={() => void agent.refresh()}>Try again</button></div> : null}
        {running ? <p className="gx-hint" role="status" data-testid="reference-running">The review is running · {aboutCredits(running.estimateCredits)} reserved. It appears here when it is ready.</p> : null}
        {analysis ? (
          <div className="bo-review" data-testid="reference-analysis">
            {history.length > 1 ? (
              <Field label="Saved review">
                <select className="gx-select" value={analysis.jobId} onChange={(e) => setChosenJob(e.target.value)} data-testid="reference-history">
                  {history.map((a) => <option key={a.jobId} value={a.jobId}>{new Date(a.createdAt).toLocaleString()}</option>)}
                </select>
              </Field>
            ) : null}
            <p className="bo-copy">{analysis.result.summary}</p>
            <ol className="bo-beats">
              {analysis.result.beats.map((beat, i) => (
                <li key={i}><span className="bo-beat-head">{analysis.evidence.samples[beat.sampleIndex]?.timeSeconds.toFixed(2)} s · still {beat.sampleIndex + 1}</span><span>{beat.observation}</span><span className="gx-hint">Adapt: {beat.adaptation}</span></li>
              ))}
            </ol>
            <dl className="bo-facts">
              <dt>Camera and framing</dt><dd>{analysis.result.camera}</dd>
              <dt>Inferred pacing</dt><dd>{analysis.result.pacing}</dd>
              <dt>Visible colours</dt><dd>{analysis.result.colors.join(" · ")}</dd>
            </dl>
            <details className="bo-details"><summary className="bo-summary">What it could not tell · {analysis.result.uncertainties.length}</summary><ul className="bo-evidence">{analysis.result.uncertainties.map((u, i) => <li key={i}>{u}</li>)}</ul></details>
            <Field label="The direction, reviewed">
              <textarea className="gx-textarea" value={reviewed} maxLength={6000} onChange={(e) => setEdits((old) => ({ ...old, [analysis.jobId]: e.target.value }))} data-testid="reference-reviewed" />
            </Field>
            <div className="gx-gen-enhance"><button type="button" className="gx-primary" disabled={!reviewed.trim()} onClick={apply} data-testid="reference-apply">Apply the direction</button></div>
          </div>
        ) : null}
      </section>
      <SaveLine editor={editor} testId="reference-save" />
      {dialog && selected ? (
        <AtomikRunDialog key={`${scope}:${p.id}:${selected.asset.id}`} approximate scope={scope} project={p} models={models}
          target={{ referenceAd: referenceAdBinding(p, value)!, role: "marketing", request: ASK, model: "auto", effort: "auto", depth: "Considered", refs: [selected.asset.id] }}
          onSave={editor.ensureSaved} onClose={() => setDialog(false)} onQueued={(id) => { setDialog(false); setChosenJob(id); void agent.refresh(); }} />
      ) : null}
    </div>
  );
}
