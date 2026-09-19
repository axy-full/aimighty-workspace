"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Plus, RefreshCw } from "lucide-react";
import { useSession } from "@/lib/session";
import { useApi } from "@/lib/useApi";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { useDraft } from "@/lib/useDraft";
import { useMoney } from "@/lib/price";
import { MODELS, modelLabel } from "@/lib/models";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import {
  ModelPicker,
  EffortPicker,
  thinkingModelName,
} from "@/components/atomik/ModelPicker";
import PipelineBuilder from "@/components/pipeline/PipelineBuilder";
import PipelineRun from "@/components/pipeline/PipelineRun";
import pipelineStyles from "@/components/pipeline/pipeline.module.css";
import {
  buildPipelineSpec,
  effectivePipelineDraft,
  emptyPipelineDraft,
  pipelineMovieProject,
  publicationKey,
  type PipelineDraft,
} from "@/lib/pipeline/editor";
import type { PublicPipelineRun } from "@/lib/pipeline/public";
import type { Project } from "@/lib/workbench/studio";
import { createMovieHandoff } from "@/lib/workbench/movie-handoff";
import {
  atomikPage,
  needsApproval,
  projectCatalog,
  recipeFromRun,
  savedRecipes,
  stageCost,
  stageStatus,
  type AtomikCatalog,
  type AtomikPage,
  type RecordedTake,
} from "./atomik-suite-data";
import styles from "./atomik-suite.module.css";
import { SuiteAgentPanel } from "./SuiteAgentPanel";
import { AtomikGenerate } from "./AtomikGenerate";

type Drafts = {
  project: Project | null;
  projects: { id: string; name: string }[];
};
type BudgetProject = {
  id: string;
  name: string;
  spend: number;
  credits: number;
  capUsd: number | null;
  capCredits: number | null;
  capUnlocked: boolean;
};
type Settings = {
  settings: Record<string, string>;
  models: { image: string; video: string; text: Record<string, string> };
};
type Props = {
  pageOverride?: AtomikPage;
  heading?: string;
  pageTitle?: string;
};
const providerNames: Record<string, string> = {
  byteplus: "BytePlus ModelArk",
  google: "Google",
  fal: "fal",
  higgsfield: "Higgsfield",
  elevenlabs: "ElevenLabs",
};
function provider(model: string) {
  if (
    model.startsWith("anthropic/") ||
    model.startsWith("openai/") ||
    model.startsWith("google/")
  )
    return "Vercel AI Gateway";
  const engine = MODELS.find((item) => item.id === model);
  return engine
    ? (providerNames[engine.provider] ?? engine.provider)
    : model.startsWith("eleven_") ||
        model === "music_v1" ||
        model === "sound_effects_v1"
      ? "ElevenLabs"
      : "Provider unavailable";
}
const amount = (value: number | null, unit: string = "cr") =>
  value === null
    ? "Not available"
    : unit === "cr"
      ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} cr`
      : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** Content only: the common shell owns suite navigation, project context and the rail. */
export default function AtomikSuite({
  pageOverride,
  heading = "Atomik Agent",
  pageTitle,
}: Props) {
  const session = useSession(),
    search = useSearchParams(),
    pathname = usePathname();
  const projectId = search.get("project"),
    page = pageOverride ?? atomikPage(search.get("page"));
  const drafts = useApi<Drafts>(
    session.requestScope
      ? `/api/workbench/projects${projectId ? `?id=${encodeURIComponent(projectId)}` : ""}`
      : null,
    0,
    session.requestScope,
  );
  if (!session.signedIn)
    return (
      <section className={styles.suite}>
        <h1>{heading}</h1>
        <p>Sign in to open your saved production plans.</p>
        <Link href="/login?next=%2Fatomik">Sign in</Link>
      </section>
    );
  if (drafts.error)
    return (
      <section className={styles.suite} role="alert">
        <h1>{heading}</h1>
        <p>{drafts.error}</p>
        <button onClick={() => void drafts.refresh()}>Retry projects</button>
      </section>
    );
  if (!drafts.data)
    return (
      <section className={styles.suite} aria-label={`${heading} suite`}>
        <p role="status">Opening your projects…</p>
      </section>
    );
  const project =
    drafts.data.project?.id === projectId ? drafts.data.project : null;
  if (!project?.productionProjectId)
    return (
      <section className={styles.suite} aria-label={`${heading} suite`}>
        <h1>{heading}</h1>
        <div className={styles.empty}>
          <h2>Choose a saved project</h2>
          <p>
            {projectId
              ? "This project must be saved in Studio before opening its production plans."
              : "Runs, recipes and budgets stay with the project you choose."}
          </p>
          <div className={styles.projectChoices}>
            {drafts.data.projects.map((item) => {
              const params = new URLSearchParams(search.toString());
              params.set("project", item.id);
              return (
                <Link key={item.id} href={`${pathname}?${params}`}>
                  {item.name}
                </Link>
              );
            })}
          </div>
          <Link href="/workbench">Open Projects</Link>
        </div>
      </section>
    );
  return (
    <MappedAtomik
      key={`${session.requestScope}:${project.id}`}
      project={project}
      page={page}
      heading={heading}
      pageTitle={pageTitle}
      refreshProject={drafts.refresh}
    />
  );
}

function MappedAtomik({
  project,
  page,
  heading,
  pageTitle,
  refreshProject,
}: {
  project: Project;
  page: AtomikPage;
  heading: string;
  pageTitle?: string;
  refreshProject: () => Promise<void>;
}) {
  const session = useSession(),
    money = useMoney(),
    fetchScoped = useScopedFetch(),
    router = useRouter(),
    search = useSearchParams(),
    pathname = usePathname();
  const productionId = project.productionProjectId!;
  const catalogResult = useApi<AtomikCatalog>(
    `/api/pipelines?projectId=${encodeURIComponent(productionId)}`,
    page === "runs" || page === "approvals" ? 30000 : 0,
    session.requestScope,
  );
  const catalog = catalogResult.data
    ? projectCatalog(catalogResult.data, productionId)
    : null;
  const [savedRun, setSavedRun] = useState<PublicPipelineRun | null>(null);
  const [building, setBuilding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const mergedRuns = catalog
    ? [
        ...(savedRun && !catalog.runs.some((run) => run.id === savedRun.id)
          ? [savedRun]
          : []),
        ...catalog.runs.map((run) =>
          savedRun?.id === run.id && savedRun.revision >= run.revision
            ? savedRun
            : run,
        ),
      ]
    : [];
  const filtered =
    page === "approvals" ? mergedRuns.filter(needsApproval) : mergedRuns;
  const selected =
    filtered.find((run) => run.id === search.get("run")) ?? filtered[0] ?? null;
  const readingRun = page === "runs" || page === "approvals";
  const liveRun = useApi<{ run: PublicPipelineRun }>(
    selected && readingRun
      ? `/api/pipelines/${encodeURIComponent(selected.id)}`
      : null,
    selected &&
      readingRun &&
      !["succeeded", "cancelled"].includes(selected.state)
      ? 5000
      : 0,
    session.requestScope,
  );
  const run =
    selected &&
    liveRun.data?.run &&
    liveRun.data.run.id === selected.id &&
    liveRun.data.run.context.projectId === productionId &&
    liveRun.data.run.revision >= selected.revision
      ? liveRun.data.run
      : selected;
  const jobs = useApi<{
    generations: RecordedTake[];
    nextPageCursor?: string | null;
  }>(
    run && readingRun
      ? `/api/jobs?projectId=${encodeURIComponent(productionId)}&sync=0&limit=500&pagination=stable`
      : null,
    30000,
    session.requestScope,
  );
  const draft = useDraft<PipelineDraft>(
    `atomik-pipeline:${project.id}`,
    emptyPipelineDraft,
  );
  const voices = useApi<{ voices: { id: string; name: string }[] }>(
    building && draft.value.audio === "speech" ? "/api/audio/voices" : null,
    0,
    session.requestScope,
  );
  const values = catalog
    ? effectivePipelineDraft(draft.value, catalog)
    : draft.value;
  const publication =
    catalog?.publications.find(
      (item) => publicationKey(item) === draft.value.publication,
    ) ?? catalog?.publications[0];
  const availableRatios = ["16:9", "9:16", "1:1", "4:5"].filter(
    (ratio) =>
      values.output === "audio" ||
      ((!catalog?.models.find((model) => model.id === values.imageModel) ||
        catalog.models
          .find((model) => model.id === values.imageModel)!
          .ratios.includes(ratio)) &&
        (values.output !== "video" ||
          !catalog?.models.find((model) => model.id === values.videoModel) ||
          catalog.models
            .find((model) => model.id === values.videoModel)!
            .ratios.includes(ratio))),
  );
  async function api(url: string, body?: Record<string, unknown>) {
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
    const data = await response.json().catch(() => null);
    if (!response.ok || !data)
      throw new Error(
        data?.error ||
          "The request could not be confirmed. Reload saved state before trying again.",
      );
    return data;
  }
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (problem) {
      if (active.current)
        setError(
          problem instanceof Error ? problem.message : "Please try again.",
        );
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function acceptRun(next: PublicPipelineRun, navigate = false) {
    if (next.context.projectId !== productionId)
      throw new Error("This run belongs to a different project.");
    if (!active.current) return;
    setSavedRun(next);
    setBuilding(false);
    if (navigate) {
      const params = new URLSearchParams(search.toString());
      params.set("run", next.id);
      router.replace(`${pathname}?${params}`, { scroll: false });
    }
    void catalogResult.refresh();
    void liveRun.refresh();
    void jobs.refresh();
  }
  async function action(body: Record<string, unknown>) {
    if (!run) return;
    const result = await api(`/api/pipelines/${encodeURIComponent(run.id)}`, {
      revision: run.revision,
      ...body,
    });
    acceptRun(result.run);
  }
  function selectRun(next: PublicPipelineRun) {
    setBuilding(false);
    setError("");
    const params = new URLSearchParams(search.toString());
    params.set("run", next.id);
    router.replace(`${pathname}?${params}`, { scroll: false });
  }
  function openMovie(manifest: unknown) {
    if (!run || !session.requestScope) return;
    try {
      window.location.assign(
        createMovieHandoff(
          pipelineMovieProject(run.name, run.context, manifest),
          session.requestScope,
        ),
      );
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Movie export could not be opened.",
      );
    }
  }
  const studioHref = `/workbench?${new URLSearchParams({ project: project.id, view: "workspace" })}`;
  return (
    <section
      className={`${styles.suite} ${pipelineStyles.workspace}`}
      aria-label={`${heading} suite`}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.suiteName}>
            <span />
            {heading} · {project.name}
          </p>
          <h1>{pageTitle ?? page.charAt(0).toUpperCase() + page.slice(1)}</h1>
          <p>
            {page === "runs"
              ? "Readable plans, approved stages, and recoverable production history."
              : page === "generate"
                ? "Image, video, sound and 3D workflows on the connected account, each quoted in connected credits before it runs."
              : page === "recipes"
                ? "Reuse a saved plan with its exact context, models and checkpoints."
                : page === "approvals"
                  ? "Review the next decision before any new stage spends credits."
                  : page === "budget"
                    ? "Recorded project spend and the cap applied to new work."
                    : "The models and routing your workspace actually uses."}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Link href={studioHref}>Open Studio</Link>
          {(page === "runs" || page === "recipes") && (
            <button
              className={styles.primary}
              disabled={busy}
              onClick={() => {
                setBuilding(true);
                setError("");
              }}
            >
              <Plus size={15} />
              New plan · 0 cr
            </button>
          )}
        </div>
      </header>
      {page === "runs" && <SuiteAgentPanel key={`${project.id}:${heading}`} suite="atomik" project={project} />}
      {(error || catalogResult.error || liveRun.error) && (
        <div className={styles.error} role="alert">
          <p>{error || catalogResult.error || liveRun.error}</p>
          <button
            disabled={busy}
            onClick={() => {
              setError("");
              void catalogResult.refresh();
              void liveRun.refresh();
            }}
          >
            <RefreshCw size={15} />
            Reload saved state
          </button>
        </div>
      )}
      {!catalog ? (
        <p role="status">Loading saved plans…</p>
      ) : building ? (
        <div className={styles.panel}>
          <div className={styles.panelHeading}>
            <h2>Build a production plan</h2>
            <button disabled={busy} onClick={() => setBuilding(false)}>
              Close builder
            </button>
          </div>
          {!publication ? (
            <div className={styles.empty}>
              <h3>Publish your project context first</h3>
              <p>
                Share the intended brief, nodes and source assets in Studio.
                Your private edits remain private.
              </p>
              <Link href={studioHref}>Open Studio</Link>
            </div>
          ) : (
            <div className={styles.pipeline}>
              <PipelineBuilder
                catalog={catalog}
                publication={publication}
                values={values}
                set={(key, value) =>
                  draft.set((previous) => ({ ...previous, [key]: value }))
                }
                busy={busy}
                voices={voices.data?.voices ?? []}
                availableRatios={availableRatios}
                onCreate={() =>
                  void perform(async () => {
                    const result = await api("/api/pipelines", {
                      spec: buildPipelineSpec(values, publication, catalog),
                      expectedVersion: 0,
                    });
                    acceptRun(result.run, true);
                    if (active.current) draft.clear();
                  })
                }
              />
              {voices.error && <p role="alert">{voices.error}</p>}
            </div>
          )}
        </div>
      ) : page === "recipes" ? (
        <Recipes
          runs={mergedRuns}
          busy={busy}
          create={(recipe) =>
            perform(async () => {
              const result = await api("/api/pipelines", {
                spec: recipeFromRun(recipe),
                expectedVersion: 0,
              });
              acceptRun(result.run);
              if (active.current) {
                const params = new URLSearchParams(search.toString());
                params.set("run", result.run.id);
                params.set(
                  "page",
                  "runs",
                );
                router.push(`${pathname}?${params}`);
              }
            })
          }
        />
      ) : page === "generate" ? (
        <AtomikGenerate project={project} scope={session.requestScope ?? ""} refreshProject={refreshProject} />
      ) : page === "budget" ? (
        <Budget productionId={productionId} />
      ) : page === "models" ? (
        <Models catalog={catalog} />
      ) : (
        <div className={styles.runLayout}>
          <aside
            className={styles.runList}
            aria-label={
              page === "approvals" ? "Runs needing approval" : "Saved runs"
            }
          >
            <div className={styles.panelHeading}>
              <h2>
                {page === "approvals" ? "Needs a decision" : "Saved runs"}
              </h2>
              <span>{filtered.length}</span>
            </div>
            <p>Private to your account · latest 50 runs</p>
            {filtered.map((item) => (
              <button
                key={item.id}
                className={styles.runButton}
                aria-current={run?.id === item.id ? "page" : undefined}
                disabled={busy}
                onClick={() => selectRun(item)}
              >
                <strong>{item.name}</strong>
                <span>
                  {item.state.replaceAll("_", " ")} · v{item.pipelineVersion}
                </span>
                <small>
                  {item.stages.length}{" "}
                  {item.stages.length === 1 ? "step" : "steps"} ·{" "}
                  {new Date(item.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
            {!filtered.length && (
              <p>
                {page === "approvals"
                  ? "No saved runs need a decision."
                  : "No production runs yet."}
              </p>
            )}
          </aside>
          <div className={styles.runBody}>
            {run ? (
              <>
                <div className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div>
                      <h2>{run.name}</h2>
                      <p>
                        Published context v{run.context.bibleVersion} ·{" "}
                        {run.state.replaceAll("_", " ")}
                      </p>
                    </div>
                    <SaveRecipe run={run} />
                  </div>
                  <div className={styles.tableScroll}>
                    <table
                      className={styles.table}
                      aria-label="Production plan"
                    >
                      <thead>
                        <tr>
                          <th>Step</th>
                          <th>Model / provider</th>
                          <th>Status</th>
                          <th>Latest quote</th>
                          <th>Recorded actual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.stages.map((stage, index) => {
                          const model =
                              "model" in stage.definition
                                ? stage.definition.model
                                : null,
                            cost = stageCost(
                              run,
                              stage.definition.id,
                              jobs.data?.generations ?? [],
                              money.inCredits,
                            );
                          return (
                            <tr key={stage.definition.id}>
                              <td>
                                <span className={styles.stepNumber}>
                                  {index + 1}
                                </span>
                                <strong>{stage.definition.label}</strong>
                                <small>{stage.definition.kind}</small>
                              </td>
                              <td>
                                {model ? (
                                  <>
                                    {modelLabel(model)}
                                    <small>{provider(model)}</small>
                                  </>
                                ) : stage.definition.kind === "review" ? (
                                  "Human review"
                                ) : (
                                  "Particl assembly"
                                )}
                              </td>
                              <td>
                                <span
                                  className={
                                    stage.definition.kind === "review"
                                      ? styles.checkpoint
                                      : styles.status
                                  }
                                >
                                  {stageStatus(run, stage.definition.id)}
                                </span>
                              </td>
                              <td>
                                {model
                                  ? cost.estimate === null
                                    ? "Quote when ready"
                                    : amount(
                                        cost.estimate,
                                        cost.estimateUnit ?? "cr",
                                      )
                                  : "No generation charge"}
                              </td>
                              <td>
                                {model
                                  ? cost.actual === null
                                    ? "Pending / unavailable"
                                    : amount(
                                        cost.actual,
                                        money.inCredits ? "cr" : "usd",
                                      )
                                  : "No generation charge"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.note}>
                    Quotes cover the listed stage, not the whole run. Actuals
                    include recorded attempts; unsettled or older unavailable
                    charges stay unreported here.{" "}
                    <Link href="/usage">Open the full ledger</Link>
                  </p>
                  {jobs.error && (
                    <p role="alert">
                      Recorded charges could not be loaded: {jobs.error}
                    </p>
                  )}
                </div>
                <div className={`${styles.panel} ${styles.pipeline}`}>
                  <PipelineRun
                    run={run}
                    catalog={catalog}
                    busy={busy}
                    perform={perform}
                    action={action}
                    openMovie={openMovie}
                  />
                </div>
              </>
            ) : (
              <div className={styles.empty}>
                <h2>
                  {page === "approvals"
                    ? "Your approval queue is clear"
                    : "Build your first plan"}
                </h2>
                <p>
                  {page === "approvals"
                    ? "New quotes and take selections appear here when a run needs your input."
                    : "Choose published project context, the engines and the outputs. Saving a plan is free; each generation stage needs its own priced approval."}
                </p>
                {page === "runs" && (
                  <button
                    className={styles.primary}
                    onClick={() => setBuilding(true)}
                  >
                    Create a plan · 0 cr
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SaveRecipe({ run }: { run: PublicPipelineRun }) {
  function save() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recipeFromRun(run), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${run.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "production"}-recipe.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <button onClick={save}>
      <Download size={15} />
      Save recipe
    </button>
  );
}
function Recipes({
  runs,
  busy,
  create,
}: {
  runs: PublicPipelineRun[];
  busy: boolean;
  create: (run: PublicPipelineRun) => Promise<void>;
}) {
  const recipes = savedRecipes(runs);
  return (
    <div>
      <p className={styles.note}>
        Each saved run retains its reusable plan. A new run starts with no
        approvals or paid attempts and keeps the original published context.
      </p>
      <div className={styles.recipeGrid}>
        {recipes.map((run) => (
          <article
            key={`${run.pipelineId}:${run.pipelineVersion}`}
            className={styles.panel}
          >
            <h2>{run.name}</h2>
            <p>
              Plan v{run.pipelineVersion} · context v{run.context.bibleVersion}
            </p>
            <ol className={styles.recipeSteps}>
              {run.stages.map((stage) => (
                <li key={stage.definition.id}>
                  <strong>{stage.definition.label}</strong>
                  <span>
                    {"model" in stage.definition
                      ? modelLabel(stage.definition.model)
                      : stage.definition.kind === "review"
                        ? "Human checkpoint"
                        : "Timeline assembly"}
                  </span>
                </li>
              ))}
            </ol>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() => void create(run)}
              >
                Create new run · 0 cr
              </button>
              <SaveRecipe run={run} />
            </div>
          </article>
        ))}
      </div>
      {!recipes.length && (
        <div className={styles.empty}>
          <h2>No saved recipes yet</h2>
          <p>
            Create a production plan to preserve its models, inputs and
            checkpoints for reuse.
          </p>
        </div>
      )}
    </div>
  );
}

function Budget({ productionId }: { productionId: string }) {
  const session = useSession(),
    money = useMoney();
  const projects = useApi<{ projects: BudgetProject[] }>(
    "/api/projects",
    30000,
    session.requestScope,
  );
  const project = projects.data?.projects.find(
    (item) => item.id === productionId,
  );
  if (projects.error)
    return (
      <div className={styles.error} role="alert">
        {projects.error}
        <button onClick={() => void projects.refresh()}>Retry budget</button>
      </div>
    );
  if (!projects.data) return <p role="status">Loading project budget…</p>;
  if (!project)
    return <p role="alert">This project’s budget is unavailable.</p>;
  const spent = money.inCredits ? project.credits : project.spend,
    cap = money.inCredits ? project.capCredits : project.capUsd,
    unit = money.inCredits ? "cr" : "usd";
  return (
    <div className={styles.panel}>
      <div className={styles.metrics}>
        <div>
          <span>Project generation spend</span>
          <strong>{amount(spent, unit)}</strong>
        </div>
        <div>
          <span>Project cap</span>
          <strong>{cap === null ? "Not set" : amount(cap, unit)}</strong>
        </div>
        <div>
          <span>Remaining under cap</span>
          <strong>
            {cap === null
              ? "Not capped"
              : amount(Math.max(0, cap - spent), unit)}
          </strong>
        </div>
      </div>
      {cap !== null && (
        <progress
          aria-label="Project cap used"
          max={Math.max(cap, 1)}
          value={Math.min(spent, Math.max(cap, 1))}
        />
      )}
      <p>
        {project.capUnlocked
          ? "A producer has unlocked the project cap."
          : "New work follows the workspace’s approval and cap rules."}
      </p>
      <p className={styles.note}>
        Project spend includes generation and prompt refinement, including
        deleted takes. The workspace ledger also records other Atomik text work.
      </p>
      {session.role === "owner" || session.role === "admin" ? (
        <BudgetForm
          key={`${project.id}:${cap}`}
          project={project}
          credits={money.inCredits}
          refresh={() => void projects.refresh()}
        />
      ) : (
        <p className={styles.note}>A workspace admin can change this cap.</p>
      )}
      <div className={styles.actions}>
        <Link href="/usage">Open workspace ledger</Link>
        <Link href="/settings">Approval settings</Link>
      </div>
    </div>
  );
}
function BudgetForm({
  project,
  credits,
  refresh,
}: {
  project: BudgetProject;
  credits: boolean;
  refresh: () => void;
}) {
  const fetchScoped = useScopedFetch(),
    [value, setValue] = useState(
      String((credits ? project.capCredits : project.capUsd) ?? ""),
    ),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    lock = useRef(false);
  return (
    <form
      className={styles.inlineForm}
      onSubmit={async (event) => {
        event.preventDefault();
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setMessage("");
        try {
          const response = await fetchScoped(
            `/api/projects/${encodeURIComponent(project.id)}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                [credits ? "capCredits" : "capUsd"]:
                  value === "" ? null : Number(value),
              }),
            },
          );
          const result = await response.json().catch(() => null);
          if (!response.ok)
            throw new Error(result?.error || "Could not save this cap.");
          setMessage("Project cap saved.");
          refresh();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save this cap.",
          );
        } finally {
          lock.current = false;
          setBusy(false);
        }
      }}
    >
      <label>
        Project cap ({credits ? "credits" : "USD"})
        <input
          type="number"
          min="0"
          step={credits ? "1" : "0.01"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="No cap"
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save cap"}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

function Models({ catalog }: { catalog: AtomikCatalog }) {
  const session = useSession(),
    money = useMoney(),
    atomik = useAtomik();
  const settings = useApi<Settings>("/api/settings", 0, session.requestScope);
  const current = atomik.models.find((model) => model.id === atomik.model);
  return (
    <div className={styles.modelLayout}>
      <section className={styles.panel}>
        <h2>Atomik thinking</h2>
        <p>
          The model and effort for the current Atomik rail. A saved request
          keeps its approved settings while recovery is pending.
        </p>
        <div className={styles.pickers}>
          <ModelPicker
            value={atomik.model}
            models={atomik.models}
            onPick={atomik.setThinkingModel}
            disabled={atomik.busy || !!atomik.recoveryText}
          />
          <EffortPicker
            value={atomik.effort}
            model={current}
            onPick={atomik.setReasoningEffort}
            disabled={atomik.busy || !!atomik.recoveryText}
          />
        </div>
        <p className={styles.note}>
          Choose a model in Brief or Script for those agentic tasks. This
          control does not replace their saved requests.
        </p>
      </section>
      <section className={styles.panel}>
        <h2>Effective routing</h2>
        {settings.error ? (
          <p role="alert">{settings.error}</p>
        ) : !settings.data ? (
          <p role="status">Loading model routing…</p>
        ) : (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Model</th>
                    <th>Provider</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(settings.data.models.text ?? {}).map(
                    ([job, model]) => (
                      <tr key={job}>
                        <td>
                          {job === "enhance"
                            ? "Prompt enhancement"
                            : job === "idea"
                              ? "Ideas and treatments"
                              : job === "shot"
                                ? "Shot lists"
                                : job}
                        </td>
                        <td>{thinkingModelName(model, atomik.models)}</td>
                        <td>{provider(model)}</td>
                      </tr>
                    ),
                  )}
                  {(["image", "video"] as const).map((kind) => (
                    <tr key={kind}>
                      <td>
                        {kind === "image" ? "Default stills" : "Default video"}
                      </td>
                      <td>{modelLabel(settings.data!.models[kind])}</td>
                      <td>{provider(settings.data!.models[kind])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.note}>
              Workspace defaults seed new work. Saved plans retain their chosen
              models.
            </p>
            <Link href="/settings#engines">Manage engines and routing</Link>
          </>
        )}
      </section>
      <section className={styles.panel}>
        <h2>Production models</h2>
        <p>
          Connection status and capabilities from the pipeline catalogue. Each
          ready stage gets an exact quote before approval.
        </p>
        <div className={styles.tableScroll}>
          <table
            className={styles.table}
            aria-label="Production model catalogue"
          >
            <thead>
              <tr>
                <th>Model / provider</th>
                <th>Output</th>
                <th>Connection</th>
                <th>Published rate</th>
              </tr>
            </thead>
            <tbody>
              {catalog.models.map((model) => {
                const rates = session.rates.models[model.id],
                  still = rates?.imagePricing,
                  second = rates?.secondRates?.[0];
                return (
                  <tr key={model.id}>
                    <td>
                      {model.label}
                      <small>{provider(model.id)}</small>
                    </td>
                    <td>
                      {model.kind}
                      <small>{model.resolutions.join(" / ")}</small>
                    </td>
                    <td>{model.configured ? "Connected" : "Not connected"}</td>
                    <td>
                      {still
                        ? Object.entries(still)
                            .map(
                              ([resolution, price]) =>
                                `${resolution}: ${money.rate(price)} / image`,
                            )
                            .join(" · ")
                        : second
                          ? `${money.rate(second.withoutAudio)} / second · ${second.resolutions.join("/")}`
                          : "Quoted from stage inputs"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
