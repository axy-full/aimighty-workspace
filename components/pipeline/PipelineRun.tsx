"use client";
import { Check, Film, RefreshCw } from "lucide-react";
import { AssetPreview } from "@/components/workbench/AssetPreview";
import type { PublicPipelineRun } from "@/lib/pipeline/service";
import type { PipelineCatalog } from "@/lib/pipeline/editor";
import { candidateAttempt, isSelectedCandidate } from "@/lib/pipeline/review";
import styles from "./pipeline.module.css";
const money = (amount: number, currency: string) =>
  currency === "cr" ? `${amount.toLocaleString()} cr` : `$${amount.toFixed(2)}`;
export default function PipelineRun({
  run,
  catalog,
  busy,
  perform,
  action,
  openMovie,
}: {
  run: PublicPipelineRun;
  catalog: PipelineCatalog;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  action: (body: Record<string, unknown>) => Promise<void>;
  openMovie: (manifest: unknown) => void;
}) {
  return (
    <>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>
            Published context v{run.context.bibleVersion} · run version{" "}
            {run.pipelineVersion}
          </p>
          <h2>{run.name}</h2>
        </div>
        <span className={styles.status}>{run.state.replaceAll("_", " ")}</span>
      </div>
      <div className={styles.toolbar}>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await action({ action: "recover" });
            })
          }
        >
          <RefreshCw size={14} /> Recover &amp; refresh
        </button>
        {!["succeeded", "cancelled"].includes(run.state) && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  action({
                    action: run.state === "paused" ? "resume" : "pause",
                  }),
                )
              }
            >
              {run.state === "paused" ? "Resume approved work" : "Pause"}
            </button>
            <button
              disabled={busy}
              onClick={() => void perform(() => action({ action: "cancel" }))}
            >
              Cancel unstarted work
            </button>
          </>
        )}
      </div>
      <p className={styles.note}>
        Pause stops unstarted work. Submitted jobs keep their original request
        and may finish. Recovery reuses saved attempts; a new paid attempt
        always needs a fresh quote.
      </p>
      <div className={styles.stageList}>
        {run.stages.map((stage, index) => {
          const d = stage.definition,
            attempts = run.attempts.filter((a) => a.stageId === d.id);
          const latest =
            "units" in d
              ? Array.from(
                  { length: d.units },
                  (_, unit) =>
                    attempts
                      .filter((a) => a.unit === unit)
                      .sort((a, b) => b.number - a.number)[0],
                )
              : [];
          const quote = [...run.quotes]
            .reverse()
            .find(
              (q) =>
                q.stageId === d.id &&
                q.approvedAt === null &&
                q.baseRevision === run.revision &&
                q.expiresAt > Date.now(),
            );
          const terminal = ["succeeded", "cancelled"].includes(run.state),
            waiting = stage.dependencies.some((id) => {
              const parent = run.stages.find((s) => s.definition.id === id);
              return parent?.definition.kind === "review"
                ? !run.selections.some((s) => s.stageId === id)
                : !run.attempts.some(
                    (a) => a.stageId === id && a.state === "succeeded",
                  );
            });
          const retryUnits = latest.flatMap((a, unit) =>
            a && ["failed", "refused"].includes(a.state) ? [unit] : [],
          );
          return (
            <article className={styles.stage} key={d.id} aria-label={d.label}>
              <div className={styles.stageTitle}>
                <span className={styles.number}>{index + 1}</span>
                <div>
                  <small>{d.kind}</small>
                  <h3>{d.label}</h3>
                </div>
                {"model" in d && (
                  <span className={styles.model}>
                    {catalog.models.find((m) => m.id === d.model)?.label ||
                      d.model}
                  </span>
                )}
              </div>
              {stage.prompt && <p className={styles.prompt}>{stage.prompt}</p>}
              {"units" in d && (
                <>
                  <div className={styles.takes}>
                    {latest.map((a, unit) => (
                      <div className={styles.take} key={unit}>
                        <span>
                          Take {unit + 1}
                          {a ? ` · attempt ${a.number}` : ""}
                        </span>
                        <small>
                          {a?.state ||
                            (waiting ? "Waiting for input" : "Not started")}
                        </small>
                        {a?.url && (
                          <>
                            {a.kind === "image" ? (
                              <AssetPreview
                                asset={{
                                  id: a.generationId!,
                                  generationId: a.generationId!,
                                  name: `Take ${unit + 1}`,
                                  kind: "image",
                                  url: a.url,
                                  category: "Pipeline",
                                  description: "",
                                  prompt: "",
                                  status: "Selected",
                                  locked: true,
                                  version: 1,
                                  refs: [],
                                }}
                              />
                            ) : a.kind === "video" ? (
                              <video src={a.url} controls preload="metadata" />
                            ) : (
                              <audio src={a.url} controls preload="metadata" />
                            )}
                            <a
                              href={`/api/media/${a.generationId}?download=1`}
                              download
                            >
                              Download take
                            </a>
                          </>
                        )}
                        {a?.error && <p role="status">{a.error}</p>}
                      </div>
                    ))}
                  </div>
                  {!terminal && !waiting && (
                    <div className={styles.stageActions}>
                      {quote ? (
                        <>
                          <span>
                            {quote.units.length}{" "}
                            {quote.units.length === 1 ? "take" : "takes"} ·{" "}
                            <strong>
                              {money(
                                quote.currency === "cr"
                                  ? quote.estimatedCredits
                                  : quote.price,
                                quote.currency,
                              )}
                            </strong>
                          </span>
                          <button
                            className={styles.primary}
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                action({
                                  action: "approve",
                                  quoteId: quote.id,
                                  fingerprint: quote.fingerprint,
                                }),
                              )
                            }
                          >
                            Approve stage ·{" "}
                            {money(
                              quote.currency === "cr"
                                ? quote.estimatedCredits
                                : quote.price,
                              quote.currency,
                            )}
                          </button>
                        </>
                      ) : (
                        <>
                          {latest.some((a) => !a) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void perform(() =>
                                  action({
                                    action: "quote",
                                    stageId: d.id,
                                  }),
                                )
                              }
                            >
                              Quote stage
                            </button>
                          )}
                          {retryUnits.length > 0 && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void perform(() =>
                                  action({
                                    action: "quote",
                                    stageId: d.id,
                                    units: retryUnits,
                                  }),
                                )
                              }
                            >
                              Quote new attempt for failed takes
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
              {d.kind === "review" && (
                <div className={styles.review}>
                  {d.candidates.map((candidate) => {
                    const a = candidateAttempt(run.attempts, candidate);
                    const selected = isSelectedCandidate(run.selections, d.id, a);
                    return (
                      <button
                        key={`${candidate.stageId}:${candidate.unit}`}
                        disabled={busy || terminal || !a || selected}
                        onClick={() =>
                          void perform(() =>
                            action({
                              action: "select",
                              stageId: d.id,
                              candidate,
                              generationId: a?.generationId,
                            }),
                          )
                        }
                      >
                        {selected && <Check size={14} />}
                        {selected ? "Selected" : "Select"} take{" "}
                        {candidate.unit + 1}
                      </button>
                    );
                  })}
                </div>
              )}
              {d.kind === "assembly" &&
                (run.assemblies[d.id] ? (
                  <div className={styles.stageActions}>
                    <p>
                      Timeline ready. Encode a movie in the dedicated renderer.
                    </p>
                    <button
                      className={styles.primary}
                      onClick={() => openMovie(run.assemblies[d.id])}
                    >
                      <Film size={16} /> Render final movie
                    </button>
                    <button
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob(
                            [JSON.stringify(run.assemblies[d.id], null, 2)],
                            { type: "application/json" },
                          ),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "pipeline-timeline.json";
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      Download timeline manifest
                    </button>
                  </div>
                ) : (
                  <p className={styles.note}>
                    Waiting for selected pictures and sound. This stage prepares
                    an editorial timeline; movie encoding is a separate action.
                  </p>
                ))}
            </article>
          );
        })}
      </div>
    </>
  );
}
