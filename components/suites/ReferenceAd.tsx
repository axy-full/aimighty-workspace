"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import {
  AtomikRunDialog,
  type AtomikRunTarget,
} from "@/components/workbench/AtomikRunDialog";
import type { ThinkingModel } from "@/components/atomik/ModelPicker";
import {
  applyReferenceAdAnalysis,
  assertReferenceAnalysisSource,
  referenceAdAnalysisSchema,
  REFERENCE_AD_LIMITATION,
  type ReferenceAdAnalysis,
} from "@/lib/workbench/reference-ad-analysis";
import type { Project } from "@/lib/workbench/studio";
import {
  normalizeReferenceAd,
  referenceAdOriginals,
  selectReferenceAd,
  referenceAdBinding,
  type ReferenceAdConfig,
} from "@/lib/workbench/reference-ad";

/** Standalone reference review. Parent owns persistence; this component never submits media. */
export function ReferenceAd({
  project,
  enabled,
  value,
  onChange,
  scope,
  onSave,
}: {
  project: Project;
  enabled: boolean;
  value: ReferenceAdConfig;
  onChange: (value: ReferenceAdConfig) => void;
  scope?: string;
  onSave?: () => Promise<boolean>;
}) {
  const originals = referenceAdOriginals(project);
  const selected = originals.find((item) => item.asset.id === value.assetId);
  const missing = Boolean(value.assetId && !selected);
  const notified = useRef<string | null>(null);
  const request = useScopedFetch(scope ?? null);
  const [target, setTarget] = useState<AtomikRunTarget | null>(null);
  const [models, setModels] = useState<ThinkingModel[]>([]);
  const [analyses, setAnalyses] = useState<ReferenceAdAnalysis[]>([]);
  const [analysisScope, setAnalysisScope] = useState("");
  const currentScope = JSON.stringify([scope, project.id]);
  const [pendingJobs, setPendingJobs] = useState(0);
  const [selectedAnalysis, setSelectedAnalysis] = useState("");
  const [directions, setDirections] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [preparing, setPreparing] = useState(false);
  const latest = useRef({ project, value, scope, enabled });
  useLayoutEffect(() => {
    latest.current = { project, value, scope, enabled };
  }, [project, value, scope, enabled]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !scope) return;
    let current = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await request(
          "/api/workbench/atomik?" +
            new URLSearchParams({ projectId: project.id }),
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || "Saved reference analyses could not be loaded.",
          );
        if (!current) return;
        if (!Array.isArray(data.jobs) || !Array.isArray(data.models))
          throw new Error("Saved reference analyses could not be verified.");
        setModels(
          data.models.filter(
            (model: ThinkingModel) =>
              typeof model.id === "string" &&
              typeof model.name === "string" &&
              model.vision,
          ),
        );
        const found: ReferenceAdAnalysis[] = [];
        for (const job of data.jobs) {
          const parsed = referenceAdAnalysisSchema.safeParse(
            job.plan?.referenceAdAnalysis,
          );
          if (
            parsed.success &&
            parsed.data.projectId === project.id &&
            parsed.data.jobId === job.id
          )
            found.push(parsed.data);
        }
        setAnalyses(found);
        setAnalysisScope(JSON.stringify([scope, project.id]));
        const count = data.jobs.filter((job: { status: string }) =>
          ["queued", "running"].includes(job.status),
        ).length;
        setPendingJobs(count);
        if (count) timer = setTimeout(() => void load(), 4000);
      } catch (reason) {
        if (current && !controller.signal.aborted)
          setProblem(
            reason instanceof Error
              ? reason.message
              : "Saved analyses could not be loaded.",
          );
      }
    };
    void load();
    return () => {
      current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, scope, project.id, request, reload]);
  const history = [
    ...new Map(
      [
        ...(value.analysis ? [value.analysis] : []),
        ...(analysisScope === currentScope ? analyses : []),
      ]
        .filter((analysis) => {
          if (
            analysis.projectId !== project.id ||
            analysis.evidence.source.assetId !== value.assetId
          )
            return false;
          try {
            assertReferenceAnalysisSource(project, analysis.evidence.source);
            return true;
          } catch {
            return false;
          }
        })
        .map((analysis) => [analysis.jobId, analysis]),
    ).values(),
  ];
  const analysis =
    history.find((item) => item.jobId === selectedAnalysis) ?? history[0];
  const reviewedDirection = analysis
    ? (directions[analysis.jobId] ?? analysis.result.direction)
    : "";
  async function analyze() {
    if (!scope || !onSave || !selected || !enabled || preparing) return;
    const binding = referenceAdBinding(project, value)!;
    const capturedProject = project.id,
      capturedScope = scope;
    setPreparing(true);
    setProblem("");
    setNotice("");
    try {
      if (!(await onSave()))
        throw new Error("Save this project before analyzing its reference.");
      if (
        !active.current ||
        latest.current.project.id !== capturedProject ||
        latest.current.scope !== capturedScope ||
        !latest.current.enabled ||
        latest.current.value.assetId !== binding.assetId
      )
        return;
      assertReferenceAnalysisSource(latest.current.project, binding);
      setTarget({
        referenceAd: binding,
        role: "marketing",
        request:
          "Analyze the visible beats, framing, inferred pacing and colors of this reference ad. Propose an original matching direction for my supplied product and brand. Distinguish sampled evidence from inference.",
        model: "auto",
        effort: "auto",
        depth: "Considered",
        refs: [binding.assetId],
      });
    } catch (reason) {
      if (active.current)
        setProblem(
          reason instanceof Error
            ? reason.message
            : "The original could not be prepared.",
        );
    } finally {
      if (active.current) setPreparing(false);
    }
  }
  async function apply() {
    if (!analysis || !enabled || preparing) return;
    const capturedScope = scope,
      capturedProject = project.id;
    setProblem("");
    setNotice("");
    setPreparing(true);
    try {
      onChange(
        applyReferenceAdAnalysis(project, value, analysis, reviewedDirection),
      );
      if (onSave && !(await onSave()))
        throw new Error(
          "Direction applied locally. Keep this project open and retry saving.",
        );
      if (
        active.current &&
        latest.current.scope === capturedScope &&
        latest.current.project.id === capturedProject
      )
        setNotice(
          "Reviewed matching direction saved. Generating a video still requires its own engine and quote approval.",
        );
    } catch (reason) {
      if (active.current)
        setProblem(
          reason instanceof Error
            ? reason.message
            : "The current original could not be verified.",
        );
    } finally {
      if (active.current) setPreparing(false);
    }
  }

  useEffect(() => {
    if (!missing) {
      notified.current = null;
      return;
    }
    if (!enabled) return;
    const key = JSON.stringify([project.id, value.assetId]);
    if (notified.current === key) return;
    notified.current = key;
    onChange(normalizeReferenceAd(project, value));
  }, [enabled, missing, onChange, project, value]);

  return (
    <section className="suite-panel" aria-label="Reference ad">
      <div className="suite-section-heading">
        <div>
          <h2>Reference ad</h2>
          <p>
            Choose an original video, analyze its visual choices, and review the
            direction to adapt for your campaign.
          </p>
        </div>
        <span className="suite-badge">Creative reference</span>
      </div>
      <fieldset disabled={!enabled} className="suite-fields">
        <label>
          Reference video
          <select
            aria-label="Reference ad video"
            value={selected?.asset.id ?? ""}
            onChange={(event) =>
              onChange(selectReferenceAd(project, value, event.target.value))
            }
          >
            <option value="">No reference selected</option>
            {originals.map(({ asset }) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          What works in this ad
          <textarea
            aria-label="Reference ad notes"
            rows={3}
            maxLength={2000}
            value={value.notes}
            placeholder="Describe the opening, pacing, framing or sound you want to learn from."
            onChange={(event) =>
              onChange({
                ...normalizeReferenceAd(project, value),
                notes: event.target.value,
              })
            }
          />
        </label>
        <label>
          Direction for your campaign
          <textarea
            aria-label="Reference ad matching direction"
            rows={4}
            maxLength={6000}
            value={value.direction}
            placeholder="Explain which choices to adapt and how your product, brand and message should differ."
            onChange={(event) =>
              onChange({
                ...normalizeReferenceAd(project, value),
                direction: event.target.value,
              })
            }
          />
        </label>
      </fieldset>
      {missing && (
        <p role="status">
          The selected original is unavailable. Choose another project video.
        </p>
      )}
      {!originals.length && (
        <p>
          No stored project videos are available. Upload a video or add a
          generated take to the project asset library.
        </p>
      )}
      <div className="suite-actions">
        <button
          type="button"
          className="suite-primary"
          disabled={!enabled || !selected || !scope || !onSave || preparing}
          onClick={() => void analyze()}
        >
          {preparing ? "Preparing reference…" : "Analyze reference ad"}
        </button>
        <button
          type="button"
          className="suite-button"
          disabled={!enabled || !scope}
          onClick={() => {
            setProblem("");
            setReload((count) => count + 1);
          }}
        >
          Refresh saved analyses
        </button>
      </div>
      <p className="suite-footnote">
        Twelve 512px stills from an original up to 60 seconds. Choose a thinking
        model, effort and response detail, then review the credit estimate
        before analysis. No video is generated automatically.
      </p>
      {analysisScope === currentScope && !!pendingJobs && (
        <p role="status">
          Atomik is working on saved project requests. Results will appear here
          when ready.
        </p>
      )}
      {analysis && (
        <section
          aria-label="Reference ad analysis"
          style={{ display: "grid", gap: 16, marginTop: 20 }}
        >
          <label>
            Saved analysis
            <select
              aria-label="Saved reference analysis"
              value={analysis.jobId}
              onChange={(event) => setSelectedAnalysis(event.target.value)}
            >
              {history.map((item) => (
                <option key={item.jobId} value={item.jobId}>
                  {new Date(item.createdAt).toLocaleString()} · {item.model}
                </option>
              ))}
            </select>
          </label>
          <p>{analysis.result.summary}</p>
          <p className="suite-footnote">{REFERENCE_AD_LIMITATION}</p>
          <ol>
            {analysis.result.beats.map((beat, index) => (
              <li key={index}>
                <strong>
                  {analysis.evidence.samples[
                    beat.sampleIndex
                  ].timeSeconds.toFixed(2)}
                  s · Sample {beat.sampleIndex + 1}
                </strong>
                <p>{beat.observation}</p>
                <p>Adaptation: {beat.adaptation}</p>
              </li>
            ))}
          </ol>
          <dl>
            <dt>Camera and composition</dt>
            <dd>{analysis.result.camera}</dd>
            <dt>Inferred pacing</dt>
            <dd>{analysis.result.pacing}</dd>
            <dt>Visible colors</dt>
            <dd>{analysis.result.colors.join(" · ")}</dd>
          </dl>
          <details>
            <summary>Evidence and uncertainties</summary>
            <ul>
              {analysis.result.uncertainties.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            <p className="suite-footnote">
              Original {analysis.evidence.source.assetId} ·{" "}
              {analysis.evidence.durationSeconds.toFixed(2)}s ·{" "}
              {analysis.evidence.samples.length} recorded review frames
            </p>
            <p className="suite-footnote" style={{ overflowWrap: "anywhere" }}>
              {analysis.evidence.source.sourceKey}
            </p>
          </details>
          <label>
            Review matching direction
            <textarea
              aria-label="Reviewed reference matching direction"
              rows={6}
              maxLength={6000}
              value={reviewedDirection}
              disabled={!enabled || preparing}
              onChange={(event) =>
                setDirections((old) => ({
                  ...old,
                  [analysis.jobId]: event.target.value,
                }))
              }
            />
          </label>
          <button
            type="button"
            className="suite-primary"
            disabled={!enabled || preparing || !reviewedDirection.trim()}
            onClick={() => void apply()}
          >
            Apply matching direction
          </button>
        </section>
      )}
      <p className="suite-footnote">
        The original remains unchanged. Video matching uses a compatible Particl
        engine, such as Seedance, with separate source limits and generation
        approval. This analysis does not assign a virality score.
      </p>
      {problem && <p role="alert">{problem}</p>}
      {notice && <p role="status">{notice}</p>}
      {selected && (
        <figure style={{ margin: "20px 0 0" }}>
          <video
            key={`${project.id}:${selected.asset.id}:${selected.original.url}`}
            aria-label={`Reference ad preview: ${selected.asset.name}`}
            src={selected.original.url}
            controls
            playsInline
            preload="metadata"
            style={{
              display: "block",
              width: "100%",
              maxHeight: 420,
              background: "#000",
              borderRadius: 12,
            }}
          />
          <figcaption style={{ marginTop: 8, fontSize: 12 }}>
            {selected.asset.name} · Original project video
          </figcaption>
        </figure>
      )}
      {target && scope && onSave && (
        <AtomikRunDialog
          key={`${scope}:${project.id}:${target.referenceAd?.sourceKey}`}
          target={target}
          project={project}
          scope={scope}
          models={analysisScope === currentScope ? models : []}
          onSave={onSave}
          onClose={() => setTarget(null)}
          onQueued={(id) => {
            setSelectedAnalysis(id);
            setTarget(null);
            setReload((count) => count + 1);
          }}
        />
      )}
    </section>
  );
}
