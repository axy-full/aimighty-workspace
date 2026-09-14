"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, GitBranch, Loader2, Plus } from "lucide-react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useDraft } from "@/lib/useDraft";
import {
  buildPipelineSpec,
  effectivePipelineDraft,
  emptyPipelineDraft,
  pipelineMovieProject,
  publicationKey,
  type PipelineCatalog,
  type PipelineDraft,
} from "@/lib/pipeline/editor";
import type { PublicPipelineRun } from "@/lib/pipeline/service";
import { createMovieHandoff } from "@/lib/workbench/movie-handoff";
import styles from "./pipeline.module.css";
import PipelineBuilder from "./PipelineBuilder";
import PipelineRun from "./PipelineRun";

type Catalog = PipelineCatalog & { runs: PublicPipelineRun[] };
export default function PipelineWorkspace() {
  const session = useSession(),
    fetchScoped = useScopedFetch(),
    search = useSearchParams();
  const draft = useDraft<PipelineDraft>("pipeline-builder", emptyPipelineDraft);
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [run, setRun] = useState<PublicPipelineRun | null>(null);
  const [building, setBuilding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const active = useRef(true),
    request = useRef(false);
  const workspaceId = session.workspace?.id;
  const projectId = search.get("projectId"),
    initialRunId = search.get("run");
  const api = useCallback(
    async (url: string, body?: Record<string, unknown>) => {
      const response = await fetchScoped(
        url,
        body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "This request could not be completed.");
      return data;
    },
    [fetchScoped],
  );
  useEffect(() => {
    active.current = true;
    let alive = true;
    if (session.signedIn && workspaceId) {
      api(
        `/api/pipelines${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      )
        .then(async (data) => {
          if (!alive) return;
          setCatalog(data);
          if (initialRunId) {
            const result = await api(
              `/api/pipelines/${encodeURIComponent(initialRunId)}`,
            );
            if (alive) setRun(result.run);
          } else if (data.runs.length) setRun(data.runs[0]);
          else setBuilding(true);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    }
    return () => {
      alive = false;
      active.current = false;
    };
  }, [api, session.signedIn, workspaceId, projectId, initialRunId]);
  useEffect(() => {
    if (draft.value.audio !== "speech" || !session.signedIn) return;
    let alive = true;
    api("/api/audio/voices")
      .then((data) => {
        if (alive) setVoices(data.voices ?? []);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [api, draft.value.audio, session.signedIn]);
  useEffect(() => {
    if (
      !run ||
      !run.attempts.some((a) =>
        ["queued", "submitting", "running", "uncertain"].includes(a.state),
      ) ||
      run.state === "cancelled"
    )
      return;
    let alive = true;
    const timer = setInterval(() => {
      if (request.current) return;
      api(`/api/pipelines/${run.id}`)
        .then((data) => {
          if (alive)
            setRun((current) =>
              current &&
              current.id === data.run.id &&
              data.run.revision >= current.revision
                ? data.run
                : current,
            );
        })
        .catch(() => {});
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, run]);
  async function perform(work: () => Promise<void>) {
    if (request.current) return;
    request.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      request.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function action(body: Record<string, unknown>) {
    if (!run) return;
    const result = await api(`/api/pipelines/${run.id}`, {
      revision: run.revision,
      ...body,
    });
    if (active.current) setRun(result.run);
  }
  const values = catalog
    ? effectivePipelineDraft(draft.value, catalog)
    : draft.value;
  const availableRatios = ["16:9", "9:16", "1:1", "4:5"].filter(
    (r) =>
      values.output === "audio" ||
      ((!catalog?.models.find((m) => m.id === values.imageModel) ||
        catalog.models
          .find((m) => m.id === values.imageModel)!
          .ratios.includes(r)) &&
        (values.output !== "video" ||
          !catalog?.models.find((m) => m.id === values.videoModel) ||
          catalog.models
            .find((m) => m.id === values.videoModel)!
            .ratios.includes(r))),
  );
  const publication =
    catalog?.publications.find(
      (p) => publicationKey(p) === draft.value.publication,
    ) ?? catalog?.publications[0];
  const set = (
    key: keyof PipelineDraft,
    value: PipelineDraft[keyof PipelineDraft],
  ) => draft.set((old) => ({ ...old, [key]: value }));
  function openMovie(manifest: unknown) {
    if (!run || !session.workspace || !session.requestScope) return;
    try {
      const project = pipelineMovieProject(run.name, run.context, manifest);
      window.location.assign(createMovieHandoff(project, session.requestScope));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Movie export could not be opened.",
      );
    }
  }
  return (
    <main className={styles.workspace}>
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Production automation</p>
          <h1>
            <GitBranch size={26} /> Pipelines
          </h1>
          <p>
            Generate, choose takes, and build an edit from published production
            context.
          </p>
        </div>
        <Link href="/workbench">
          Back to Studio <ArrowRight size={14} />
        </Link>
      </header>
      {!session.signedIn ? (
        <section className={styles.empty}>
          <h2>Your production, stage by stage.</h2>
          <p>Sign in to build a pipeline in your own workspace.</p>
          <Link href="/login?next=%2Fpipelines">Sign in</Link>
        </section>
      ) : !session.workspace ? (
        <section className={styles.empty}>
          <h2>Choose a workspace</h2>
          <Link href="/billing">Open workspace setup</Link>
        </section>
      ) : (
        <>
          {error && (
            <div className={styles.error} role="alert">
              <span>{error}</span>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (run) {
                      const data = await api(`/api/pipelines/${run.id}`);
                      setRun(data.run);
                    } else {
                      setCatalog(await api("/api/pipelines"));
                    }
                  })
                }
              >
                Reload saved state
              </button>
            </div>
          )}
          {!catalog ? (
            <p role="status">
              <Loader2 size={16} /> Loading pipelines…
            </p>
          ) : (
            <div className={styles.layout}>
              <aside className={styles.sidebar} aria-label="Your pipeline runs">
                <div className={styles.sidebarHeading}>
                  <h2>Your runs</h2>
                  <button
                    disabled={busy}
                    aria-label="New pipeline"
                    onClick={() => {
                      setBuilding(true);
                      setError("");
                    }}
                  >
                    <Plus size={18} />
                  </button>
                </div>
                <p>
                  Runs are private to the account that creates them. Published
                  context remains shared.
                </p>
                {catalog.runs.map((item) => (
                  <button
                    className={styles.runLink}
                    aria-current={
                      !building && run?.id === item.id ? "page" : undefined
                    }
                    key={item.id}
                    onClick={() =>
                      void perform(async () => {
                        const data = await api(`/api/pipelines/${item.id}`);
                        setRun(data.run);
                        setBuilding(false);
                      })
                    }
                  >
                    <span>{item.name}</span>
                    <small>
                      Version {item.pipelineVersion} ·{" "}
                      {item.state.replaceAll("_", " ")}
                    </small>
                  </button>
                ))}
                {!catalog.runs.length && <p>No runs yet.</p>}
              </aside>
              <section className={styles.main}>
                {building ? (
                  <>
                    <div className={styles.sectionHeading}>
                      <h2>Build a pipeline</h2>
                      {run && (
                        <button onClick={() => setBuilding(false)}>
                          Return to run
                        </button>
                      )}
                    </div>
                    {!publication ? (
                      <div className={styles.empty}>
                        <h3>Publish the intended context first</h3>
                        <p>
                          In Studio, share the brief, nodes, and source assets
                          you want this pipeline to use. A pipeline never
                          publishes private edits for you.
                        </p>
                        <Link href="/workbench">Open Studio</Link>
                      </div>
                    ) : (
                      <PipelineBuilder
                        catalog={catalog}
                        publication={publication}
                        values={values}
                        set={set}
                        busy={busy}
                        voices={voices}
                        availableRatios={availableRatios}
                        onCreate={() =>
                          void perform(async () => {
                            const data = await api("/api/pipelines", {
                              spec: buildPipelineSpec(
                                values,
                                publication,
                                catalog,
                              ),
                              expectedVersion: 0,
                            });
                            if (!active.current) return;
                            setRun(data.run);
                            setCatalog((old) =>
                              old
                                ? { ...old, runs: [data.run, ...old.runs] }
                                : old,
                            );
                            setBuilding(false);
                            draft.clear();
                          })
                        }
                      />
                    )}
                  </>
                ) : run ? (
                  <PipelineRun
                    run={run}
                    catalog={catalog}
                    busy={busy}
                    perform={perform}
                    action={action}
                    openMovie={openMovie}
                  />
                ) : (
                  <p>Select a run or create a pipeline.</p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}
