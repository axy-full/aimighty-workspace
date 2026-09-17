"use client";

import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  GitBranch,
  Megaphone,
  Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import type { MarketingBrief, Plan, Project } from "@/lib/workbench/studio";
import { safeName } from "@/lib/workbench/studio";
import { MARKETING_BRIEF_LIMITS } from "@/lib/workbench/marketing-brief";
import {
  isMarketingPlan,
  MARKETING_TASKS,
  marketingCsv,
  marketingMarkdown,
  marketingRequest,
  type MarketingTask,
} from "@/lib/workbench/marketing-studio";
import { downloadFile } from "@/lib/workbench/studio-export";
import type { AtomikJob } from "./use-production-jobs";
import styles from "./MarketingStudioPanel.module.css";

const CHANNELS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "LinkedIn",
  "Meta ads",
  "Search ads",
  "Email",
  "Website",
  "OOH",
  "Cinema / TV",
];
const EMPTY_BRIEF: MarketingBrief = {
  objective: "",
  offer: "",
  audience: "",
  channels: [],
  tone: "",
  constraints: "",
};

export function MarketingStudioPanel({
  project,
  enabled,
  busy,
  references,
  jobs,
  error,
  task,
  instructions,
  onTask,
  onInstructions,
  onBriefChange,
  onRun,
  onApply,
  onContext,
  onActivity,
}: {
  project: Project;
  enabled: boolean;
  busy: boolean;
  references: number;
  jobs: AtomikJob[];
  error: string;
  task: MarketingTask;
  instructions: string;
  onTask: (task: MarketingTask) => void;
  onInstructions: (instructions: string) => void;
  onBriefChange: (brief: MarketingBrief) => void;
  onRun: (request: string) => void;
  onApply: (plan: Plan) => void;
  onContext: () => void;
  onActivity: () => void;
}) {
  const brief = project.marketingBrief ?? EMPTY_BRIEF;
  const plans = project.plans.filter(isMarketingPlan).reverse();
  const active = jobs.filter(
    (job) =>
      job.role === "marketing" && ["queued", "running"].includes(job.status),
  );
  const unresolved = jobs.filter(
    (job) =>
      job.role === "marketing" && ["uncertain", "failed"].includes(job.status),
  );
  const change = <K extends keyof MarketingBrief>(
    key: K,
    value: MarketingBrief[K],
  ) => onBriefChange({ ...brief, [key]: value });
  return (
    <section className={styles.panel} aria-label="Marketing Studio">
      <header className={styles.intro}>
        <span className={styles.icon}>
          <Megaphone size={19} />
        </span>
        <h2>Marketing Studio</h2>
        <p>Turn your project into a campaign.</p>
        <small>{project.name} · Brief, script and selected references</small>
      </header>
      <fieldset className={styles.tasks} disabled={!enabled || busy}>
        <legend>Create</legend>
        {MARKETING_TASKS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={task === item.id}
            onClick={() => onTask(item.id)}
          >
            <strong>{item.name}</strong>
            <span>{item.description}</span>
            {task === item.id && <Check size={14} />}
          </button>
        ))}
      </fieldset>
      <details className={styles.brief} open>
        <summary>
          Campaign brief <span>Saved with this project</span>
        </summary>
        <fieldset disabled={!enabled || busy}>
          <label>
            Campaign objective
            <textarea
              value={brief.objective}
              maxLength={MARKETING_BRIEF_LIMITS.objective}
              placeholder="What should this campaign achieve?"
              onChange={(e) => change("objective", e.target.value)}
            />
          </label>
          <label>
            Product or offer
            <textarea
              value={brief.offer}
              maxLength={MARKETING_BRIEF_LIMITS.offer}
              placeholder="What are we promoting? Include substantiated benefits."
              onChange={(e) => change("offer", e.target.value)}
            />
          </label>
          <label>
            Campaign audience
            <textarea
              value={brief.audience}
              maxLength={MARKETING_BRIEF_LIMITS.audience}
              placeholder={project.audience || "Who are we speaking to?"}
              onChange={(e) => change("audience", e.target.value)}
            />
          </label>
          <fieldset className={styles.channels}>
            <legend>Channels</legend>
            {[...new Set([...CHANNELS, ...brief.channels])].map((channel) => (
              <label key={channel}>
                <input
                  type="checkbox"
                  checked={brief.channels.includes(channel)}
                  disabled={
                    !brief.channels.includes(channel) &&
                    brief.channels.length >= MARKETING_BRIEF_LIMITS.channels
                  }
                  onChange={(e) =>
                    change(
                      "channels",
                      e.target.checked
                        ? [...brief.channels, channel]
                        : brief.channels.filter((value) => value !== channel),
                    )
                  }
                />
                {channel}
              </label>
            ))}
          </fieldset>
          <label>
            Brand voice
            <input
              value={brief.tone}
              maxLength={MARKETING_BRIEF_LIMITS.tone}
              placeholder="Cinematic, restrained, confident…"
              onChange={(e) => change("tone", e.target.value)}
            />
          </label>
          <label>
            Mandatories & constraints
            <textarea
              value={brief.constraints}
              maxLength={MARKETING_BRIEF_LIMITS.constraints}
              placeholder="Required claims, exclusions, timing, budget or legal copy"
              onChange={(e) => change("constraints", e.target.value)}
            />
          </label>
        </fieldset>
      </details>
      <button type="button" className={styles.context} onClick={onContext}>
        <Paperclip size={14} />
        {references} selected reference{references === 1 ? "" : "s"}
        <span>
          Choose assets <ArrowUpRight size={13} />
        </span>
      </button>
      <label className={styles.direction}>
        Creative direction <small>Optional</small>
        <textarea
          disabled={!enabled || busy}
          value={instructions}
          maxLength={6000}
          onChange={(e) => onInstructions(e.target.value)}
          placeholder="Explore an unexpected route, specify a language, or build on a previous campaign…"
        />
      </label>
      <button
        type="button"
        className={styles.run}
        disabled={!enabled || busy}
        onClick={() => onRun(marketingRequest(task, instructions))}
      >
        {busy ? "Preparing…" : "Review campaign estimate"}
        <ArrowUpRight size={15} />
      </button>
      <p className={styles.hint}>
        Choose your model, reasoning effort and detail in the next step. Review
        the credit estimate before starting. Results are saved here for review
        and handoff.
      </p>
      {!enabled && (
        <p className={styles.hint}>
          Open a saved project and sign in to develop a campaign.
        </p>
      )}
      {(active.length > 0 || unresolved.length > 0 || error) && (
        <div className={styles.status} role="status">
          <p>
            {error ||
              (unresolved.length
                ? `${unresolved.length} marketing run${unresolved.length === 1 ? "" : "s"} failed or could not be confirmed. Review Activity before starting another run.`
                : `${active.length} marketing run${active.length === 1 ? "" : "s"} in progress. You can leave this panel and return.`)}
          </p>
          <button type="button" onClick={onActivity}>
            View activity
          </button>
        </div>
      )}
      <div className={styles.results}>
        <h3>
          Campaign outputs <span>{plans.length}</span>
        </h3>
        {!plans.length && (
          <p>
            Strategy, copy and launch plans will appear here. Your source assets
            stay linked to each run.
          </p>
        )}
        {plans.map((plan) => (
          <details
            key={plan.id}
            className={styles.result}
            open={plans[0]?.id === plan.id}
          >
            <summary>
              {MARKETING_TASKS.find((item) =>
                plan.request.startsWith(item.request),
              )?.name ?? "Campaign output"}
              <small>
                {plan.applied ? "Added to canvas" : "Ready to review"}
              </small>
            </summary>
            <p>{plan.summary}</p>
            {plan.steps.map((step, index) => (
              <div className={styles.section} key={index}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <p>{step}</p>
              </div>
            ))}
            <div className={styles.actions}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      marketingMarkdown(project, plan),
                    );
                    toast.success("Campaign copied");
                  } catch {
                    toast.error(
                      "Copy is unavailable. Download the campaign instead.",
                    );
                  }
                }}
              >
                <Copy size={13} />
                Copy
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadFile(
                    new Blob([marketingMarkdown(project, plan)], {
                      type: "text/markdown;charset=utf-8",
                    }),
                    `${safeName(project.name)}_marketing_${safeName(plan.id)}.md`,
                  )
                }
              >
                <Download size={13} />
                Markdown
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadFile(
                    new Blob([marketingCsv(project, plan)], {
                      type: "text/csv;charset=utf-8",
                    }),
                    `${safeName(project.name)}_marketing_${safeName(plan.id)}.csv`,
                  )
                }
              >
                <Download size={13} />
                CSV
              </button>
              <button
                type="button"
                disabled={plan.applied || !enabled}
                onClick={() => onApply(plan)}
              >
                <GitBranch size={13} />
                {plan.applied ? "On canvas" : "Add to canvas"}
              </button>
            </div>
            <small className={styles.meta}>
              {plan.model} · {plan.depth}
              {plan.effort ? ` · ${plan.effort}` : ""} · {plan.refs.length}{" "}
              references
            </small>
          </details>
        ))}
      </div>
    </section>
  );
}
