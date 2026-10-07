"use client";
import { useMemo } from "react";
import { countsByDraft } from "@/lib/control-room/queue";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { throwIfArmed } from "@/lib/shell/fault";
import type { ProjectSummary } from "@/lib/workspace/data";
import { BriefBox } from "./BriefBox";
import { BLANK, type HomeSeed } from "./home-model";
import { ProjectGrid } from "./ProjectGrid";
import { StartFooter } from "./StartFooter";
import { TemplateRow } from "./TemplateRow";
import { useHomeNav } from "./use-home-nav";
import { useHomeStart } from "./use-home-start";
import { WaitingStrip } from "./WaitingStrip";
import "./home.css";

/**
 * What the shell hands Home (stream 1 mounts it at `?view=home` with the new interface on). `onCreate` is
 * today's create path (the shell's createProject: `newProject(name)` with the seed's fields set, then
 * PUT /api/workbench/projects): it opens the project it made and answers its id (and its production,
 * when the save's reply named it), or why it could not.
 */
export type HomeViewProps = {
  scope: string;
  projects: ProjectSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  onPick: (id: string) => void;
  onCreate: (name: string, seed: HomeSeed) => Promise<{ id: string; productionId?: string | null } | { error: string }>;
  /** Opens the workspace's starter production (the sample until stream 12's lands); the refusal, or null. */
  onStarter: () => Promise<string | null>;
  now: number;
};

/**
 * Home (design/particl-graphite/README.md § 1.1; the master's `?view=home`): "What are we making?" with
 * Start and Atomik's thinking price, the templates, Waiting for you (the shared approvals queue), and the
 * person's projects. Make, Atomik's panel, ⌘K and the Settings menu open over it; the shell's
 * `--gx-overlay-right` keeps the column clear of an open right panel.
 */
export function HomeView({ scope, projects, status, error, onRetry, onPick, onCreate, onStarter, now }: HomeViewProps) {
  throwIfArmed("home");
  const nav = useHomeNav();
  const { draft, onDraft, refs, setRefs, briefFile, setBriefFile, pending, problem, startProblem, thinking, retryThinking, figure, create, start, open, openSample } =
    useHomeStart({ scope, projects, onPick, onCreate, onStarter, openBoard: nav.openBoard });
  const approvals = useApprovals();
  /* The sample workspace spends nothing (the owner's switch): Start is not offered there. */
  const spendOff = useSampleWorkspace();
  const approvalsByDraft = useMemo(() => (approvals.status === "ready" ? countsByDraft(approvals.items) : null), [approvals.status, approvals.items]);

  return (
    <div className="gx-hm gx-scroll" data-testid="home" data-screen-label="Home">
      <div className="gx-hm-col">
        <section className="gx-hm-make" aria-labelledby="gx-hm-title">
          <h1 className="gx-hm-title" id="gx-hm-title" data-testid="page-title">What are we making?</h1>
          <BriefBox draft={draft} onDraft={onDraft} refs={refs} onRefs={setRefs} briefFile={briefFile} onBriefFile={setBriefFile} busy={pending !== null}
            footer={<StartFooter thinking={thinking} figure={figure} busy={pending === "start"} disabled={pending !== null} onStart={() => void start()} onRetry={retryThinking} problem={startProblem} off={spendOff} />} />
        </section>
        <div className="gx-hm-starts">
          <TemplateRow pending={pending === "sample" || pending === "start" ? null : pending} disabled={pending !== null} onPick={(t) => void create(t)} />
          {problem ? <p className="gx-hm-problem" role="alert" data-testid="home-problem">{problem}</p> : null}
        </div>
        <WaitingStrip items={approvals.items} now={now} onApprove={approvals.approve} onOpen={() => nav.openApprovals()} onTopUp={() => nav.openCredits()} onAll={() => nav.openApprovals()} />
        <ProjectGrid scope={scope} projects={projects} status={status} error={error} onRetry={onRetry} now={now} disabled={pending !== null} approvals={approvalsByDraft}
          onOpen={open} onNew={() => void create(BLANK)} onSample={() => void openSample()} />
      </div>
    </div>
  );
}
